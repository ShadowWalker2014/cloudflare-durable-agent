import type { ChatResponseResult, OnChatMessageOptions } from "@cloudflare/ai-chat";
import { callable, getAgentByName } from "agents";
import type { AgentToolLifecycleResult, AgentToolRunInfo } from "agents/agent-tools";
import type { TaskHandlers, TaskStep } from "agents/tasks";
import {
  convertToModelMessages,
  generateText,
  isStepCount,
  Output,
  pruneMessages,
  streamText,
  tool,
  type UIMessage
} from "ai";
import { z } from "zod";
import { inlineAttachments } from "./files";
import { errorMessage, LoggedChatAgent } from "./logged-agent";
import { BROKEN_MODEL, gateway, resolveModel, SUBAGENT_MODEL } from "./models";
import { reasoningSummaryOptions } from "./reasoning";
import { type AgentToolInput, SUBAGENT_TYPES, SubAgent } from "./subagent";

/** A durable background job, shown live in the Tasks panel. */
export type ReportView = {
  runId: string;
  topic: string;
  status: "running" | "sleeping" | "completed" | "failed" | "cancelled";
  step: string;
  sections: number;
  done: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
};

export type ChatState = { reports: ReportView[]; ownerId?: string };

/** What the browser sends with every message (useAgentChat `body`). */
export type ChatBody = { model?: string; simulateError?: boolean; userId?: string };

type ReportInput = { topic: string; runId: string };

const INSTRUCTIONS = `You are a helpful assistant in a demo of durable agents on Cloudflare.
Tools:
- getWeather: current weather for a city.
- agent: delegates a task to a sub-agent session (types below). Give it a 3-5 word description and a complete, self-contained prompt.
  For independent parts of a job, call agent several times in the same step so they run in parallel.
  Set run_in_background: true when the user does not need to wait; you will get a message when it finishes.
${Object.entries(SUBAGENT_TYPES).map(([id, t]) => `  - ${id}: ${t.blurb}`).join("\n")}
- sendEmail: sends an email. Call it directly once you have a recipient; the app shows the user an Approve / Reject card, so never ask for confirmation in text. Write the subject and body yourself if the user did not.
- startReport: starts a durable background report job that keeps running after the tab closes. Use it when the user asks for a report.
When the user attaches images or files, describe and use them. Keep answers short and use markdown.`;

/**
 * One ChatAgent Durable Object per conversation thread.
 *
 * You get for free (AIChatAgent): messages in SQLite, token streaming over a
 * WebSocket, resume after a refresh or a lost connection, recovery after a
 * deploy or crash (the turn runs in a durable fiber), multi-tab sync, stop.
 * https://developers.cloudflare.com/agents/api-reference/chat-agents/
 */
export class ChatAgent extends LoggedChatAgent<ChatState> {
  initialState: ChatState = { reports: [] };
  maxPersistedMessages = 500;

  /** Durable background jobs: each step is journaled, sleeps and retries survive restarts. */
  override readonly taskDefinitions = {
    "report@v1": (input: ReportInput, step: TaskStep) => this.buildReport(input, step)
  } satisfies TaskHandlers;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const limited = await this.rateLimitedResponse();
    if (limited) return limited;
    const body = (options?.body ?? {}) as ChatBody;
    const { id: modelId, model } = body.simulateError
      ? { id: BROKEN_MODEL, model: gateway(BROKEN_MODEL) }
      : resolveModel(body.model);

    this.log.write("info", "chat", "turn:start", { model: modelId, requestId: options?.requestId });
    const ownerId = body.userId ?? this.state.ownerId ?? "demo";
    if (this.state.ownerId !== ownerId) this.setState({ ...this.state, ownerId });
    this.ctx.waitUntil(this.updateThreadIndex(ownerId));

    const tools = this.tools();
    const started = Date.now();
    const inlined = await inlineAttachments(this.messages, this.env);
    const modelMessages = await convertToModelMessages(inlined, { tools });
    this.log.write("info", "chat", "turn:prepared", { ms: Date.now() - started, messages: modelMessages.length });

    const result = streamText({
      model,
      abortSignal: options?.abortSignal,
      instructions: INSTRUCTIONS,
      messages: pruneMessages({ messages: modelMessages, reasoning: "before-last-message" }),
      tools,
      reasoning: "low",
      providerOptions: reasoningSummaryOptions(modelId),
      stopWhen: isStepCount(8),
      onStepEnd: (step) => {
        this.log.write("info", "llm", "step:end", {
          finishReason: step.finishReason,
          toolCalls: step.toolCalls.map((c) => c.toolName),
          usage: step.usage
        });
      },
      onError: ({ error }) => {
        this.log.write("error", "llm", "stream:error", { message: errorMessage(error) });
      }
    });

    return result.toUIMessageStreamResponse({
      sendReasoning: true,
      // By default the SDK hides error details from the browser. Show them so
      // the user can see what failed and press Retry.
      onError: (error) => errorMessage(error)
    });
  }

  protected override async onChatResponse(result: ChatResponseResult) {
    this.log.write(result.status === "error" ? "error" : "info", "chat", `turn:${result.status}`, {
      requestId: result.requestId,
      error: result.error
    });
  }

  private tools() {
    return {
      getWeather: tool({
        description: "Get the current weather for a city",
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }) => {
          const geo = (await (
            await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`)
          ).json()) as { results?: { latitude: number; longitude: number; name: string; country: string }[] };
          const place = geo.results?.[0];
          if (!place) return { city, error: "City not found" };
          const wx = (await (
            await fetch(
              `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,wind_speed_10m,weather_code`
            )
          ).json()) as { current: { temperature_2m: number; wind_speed_10m: number; weather_code: number } };
          return {
            city: `${place.name}, ${place.country}`,
            temperatureC: wx.current.temperature_2m,
            windKmh: wx.current.wind_speed_10m,
            weatherCode: wx.current.weather_code
          };
        }
      }),

      // Sub-agents, Claude Code style: each call is its own session (a child
      // Durable Object) that streams inline and can be opened afterwards.
      agent: tool({
        description:
          "Launch a sub-agent to handle a task on its own. Several calls in one step run in parallel. " +
          "With run_in_background the call returns at once and you are messaged when the sub-agent finishes.",
        inputSchema: z.object({
          description: z.string().describe("3-5 word label for the task, shown in the UI"),
          prompt: z.string().describe("The complete task. The sub-agent sees nothing else, so include all context."),
          subagent_type: z.enum(Object.keys(SUBAGENT_TYPES) as [keyof typeof SUBAGENT_TYPES, ...(keyof typeof SUBAGENT_TYPES)[]]),
          run_in_background: z.boolean().optional()
        }),
        execute: async (input: AgentToolInput, { toolCallId, abortSignal }) => {
          const display = { name: SUBAGENT_TYPES[input.subagent_type].label, description: input.description };
          if (input.run_in_background) {
            const run = await this.runAgentTool(SubAgent, {
              input,
              inputPreview: input,
              parentToolCallId: toolCallId,
              display,
              detached: { notify: { source: "subagent" } }
            });
            return run.status === "running"
              ? { runId: run.runId, status: "running in the background — you will be messaged when it finishes" }
              : { runId: run.runId, status: "failed to start", error: run.error };
          }
          const run = await this.runAgentTool(SubAgent, {
            input,
            inputPreview: input,
            parentToolCallId: toolCallId,
            display,
            signal: abortSignal
          });
          return run.status === "completed"
            ? { runId: run.runId, result: run.summary || run.output || "(the sub-agent finished without a written answer — open its session to see what it did)" }
            : { runId: run.runId, status: run.status, error: run.error };
        }
      }),

      // Human in the loop: the turn pauses until the user approves or rejects.
      sendEmail: tool({
        description: "Send an email on the user's behalf. Always requires approval.",
        inputSchema: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
        needsApproval: true,
        execute: async ({ to, subject }) => {
          // A real app would call Resend / Email Workers here.
          this.log.write("info", "tool", "email:sent", { to, subject });
          return { sent: true, to, subject, messageId: `demo_${crypto.randomUUID().slice(0, 8)}` };
        }
      }),

      // Durable background job: returns at once, keeps running after the tab closes.
      startReport: tool({
        description: "Start a durable background job that writes a short report on a topic.",
        inputSchema: z.object({ topic: z.string() }),
        execute: async ({ topic }) => {
          const runId = crypto.randomUUID();
          await this.tasks.run("report@v1", { topic, runId }, { runId });
          this.setReport(runId, {
            runId,
            topic,
            status: "running",
            step: "Queued",
            sections: 0,
            done: 0,
            startedAt: Date.now()
          });
          this.log.write("info", "task", "report:started", { runId, topic });
          return { runId, status: "started", note: "Runs in the background. Progress shows in the Tasks panel." };
        }
      })
    };
  }

  // ─── Durable task ──────────────────────────────────────────────────────────

  /**
   * The handler re-runs from the top after any restart. Finished `step.do`
   * calls return their saved result instead of running again, so put every side
   * effect (LLM call, email, write) inside a step.
   */
  private async buildReport({ topic, runId }: ReportInput, step: TaskStep) {
    await step.status("Outlining");
    this.setReport(runId, { step: "Outlining", status: "running" });
    const outline = await step.do("outline", { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" } }, () =>
      this.makeOutline(topic)
    );
    this.setReport(runId, { sections: outline.length, step: "Cooling down" , status: "sleeping" });
    this.log.write("info", "task", "report:outlined", { runId, sections: outline });

    // A durable sleep: no isolate stays awake; the alarm wakes the agent again.
    await step.sleep("cool-down", "3 seconds");

    const sections: string[] = [];
    for (const [i, heading] of outline.entries()) {
      this.setReport(runId, { step: `Writing "${heading}"`, status: "running", done: i });
      sections.push(await step.do(`section:${i}`, () => this.writeSection(topic, heading)));
      this.log.write("info", "task", "report:section", { runId, index: i, heading });
    }

    await step.do("publish", async () => {
      const text = `**Report: ${topic}**\n\n${outline.map((h, i) => `### ${h}\n${sections[i]}`).join("\n\n")}`;
      // Wait for any live turn to finish so we never write over a streaming message.
      await this.waitUntilStable({ timeout: 60_000 });
      await this.persistMessages([
        ...this.messages,
        {
          id: `report-${runId}`,
          role: "assistant",
          parts: [{ type: "text", text }],
          metadata: { source: "background-task", runId }
        }
      ]);
    });

    this.setReport(runId, { status: "completed", step: "Published", done: outline.length, finishedAt: Date.now() });
    this.log.write("info", "task", "report:completed", { runId });
    return { runId, sections: outline.length };
  }

  private async makeOutline(topic: string) {
    const { output } = await generateText({
      model: gateway(SUBAGENT_MODEL),
      output: Output.object({ schema: z.object({ headings: z.array(z.string()).min(3).max(3) }) }),
      prompt: `Give three short section headings for a one-page report on: ${topic}`
    });
    if (!output) throw new Error("The model returned no outline");
    return output.headings;
  }

  private async writeSection(topic: string, heading: string) {
    const { text } = await generateText({
      model: gateway(SUBAGENT_MODEL),
      prompt: `Write one tight paragraph (60-80 words) for the section "${heading}" of a report on ${topic}. No heading.`
    });
    return text.trim();
  }

  private setReport(runId: string, patch: Partial<ReportView>) {
    const reports = this.state.reports ?? [];
    const existing = reports.find((r) => r.runId === runId);
    const next = existing
      ? reports.map((r) => (r.runId === runId ? { ...r, ...patch } : r))
      : [{ ...(patch as ReportView) }, ...reports];
    this.setState({ ...this.state, reports: next.slice(0, 20) });
  }

  // ─── Callable from the browser (agent.call / agent.stub) ───────────────────

  @callable()
  async cancelReport(runId: string) {
    await this.tasks.cancel(runId, "Cancelled by the user");
    this.setReport(runId, { status: "cancelled", step: "Cancelled", finishedAt: Date.now() });
    this.log.write("warn", "task", "report:cancelled", { runId });
  }

  // ─── Called by ThreadIndex over Durable Object RPC (branching) ─────────────

  /** Messages from the start of the thread up to and including `messageId`. */
  exportUntil(messageId: string): UIMessage[] {
    const index = this.messages.findIndex((m) => m.id === messageId);
    if (index === -1) throw new Error(`Message ${messageId} is not in this thread`);
    return structuredClone(this.messages.slice(0, index + 1));
  }

  /** Seed a brand-new thread with copied history. */
  async importHistory(messages: UIMessage[]) {
    await this.persistMessages(messages);
    this.log.write("info", "chat", "history:imported", { messages: messages.length });
  }

  // ─── Sub-agent sessions → the user's session list ──────────────────────────

  override async onAgentToolStart(run: AgentToolRunInfo) {
    this.log.write("info", "subagent", "run:started", { runId: run.runId, input: run.inputPreview });
    await this.recordSession(run, "running");
  }

  override async onAgentToolFinish(run: AgentToolRunInfo, result: AgentToolLifecycleResult) {
    this.log.write(result.status === "completed" ? "info" : "warn", "subagent", `run:${result.status}`, {
      runId: run.runId,
      error: result.error
    });
    await this.recordSession(run, result.status);
  }

  private async recordSession(run: AgentToolRunInfo, status: string) {
    const input = (run.inputPreview ?? {}) as Partial<AgentToolInput>;
    const index = await getAgentByName(this.env.ThreadIndex, this.state.ownerId ?? "demo");
    await index.recordSession({
      runId: run.runId,
      threadId: this.name,
      agentClass: run.agentType,
      subagentType: input.subagent_type ?? "general-purpose",
      description: input.description ?? "Sub-agent",
      background: Boolean(input.run_in_background),
      status,
      startedAt: run.startedAt,
      completedAt: run.completedAt
    });
  }

  /** Only reach sub-agent runs this agent actually started. */
  override async onBeforeSubAgent(_request: Request, child: { className: string; name: string }) {
    if (!this.hasAgentToolRun(child.className, child.name)) {
      return new Response("Not found", { status: 404 });
    }
  }

  private async updateThreadIndex(userId: string) {
    const firstUser = this.messages.find((m) => m.role === "user");
    const text = firstUser?.parts.find((p) => p.type === "text")?.text ?? "New chat";
    const index = await getAgentByName(this.env.ThreadIndex, userId);
    await index.touch(this.name, text.slice(0, 60));
  }
}
