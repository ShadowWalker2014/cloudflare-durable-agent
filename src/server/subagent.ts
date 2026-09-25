import type { OnChatMessageOptions } from "@cloudflare/ai-chat";
import { convertToModelMessages, getToolName, isStepCount, isToolUIPart, streamText, tool, type UIMessage } from "ai";
import { z } from "zod";
import { errorMessage, LoggedChatAgent } from "./logged-agent";
import { gateway, type ModelId } from "./models";
import { SUBAGENT_LABELS } from "./subagent-labels";

/**
 * Sub-agents, the way Claude Code runs them: the parent calls an `agent` tool
 * with a short description, a full prompt and a sub-agent type. Each run is a
 * child Durable Object (a facet of the parent chat) with its own transcript,
 * tools, logs and resumable stream — a real session you can open, read, and
 * keep talking to.
 * https://developers.cloudflare.com/agents/api-reference/sub-agents/
 * https://developers.cloudflare.com/agents/api-reference/agent-tools/
 */
export type SubAgentType = "researcher" | "writer" | "general-purpose";

export type AgentToolInput = {
  description: string;
  prompt: string;
  subagent_type: SubAgentType;
  run_in_background?: boolean;
};

type SubAgentState = { type: SubAgentType; description: string };

const TOOLS = {
  wikipedia_search: tool({
    description: "Search Wikipedia. Returns the top article titles and snippets.",
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) => {
      const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=${encodeURIComponent(query)}`;
      const data = (await (await fetch(url, { headers: UA })).json()) as {
        query?: { search: { title: string; snippet: string }[] };
      };
      return (data.query?.search ?? []).map((r) => ({ title: r.title, snippet: r.snippet.replace(/<[^>]+>/g, "") }));
    }
  }),
  wikipedia_page: tool({
    description: "Read the summary of one Wikipedia article by exact title.",
    inputSchema: z.object({ title: z.string() }),
    execute: async ({ title }) => {
      const res = await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replaceAll(" ", "_"))}`,
        { headers: UA }
      );
      if (!res.ok) return { found: false, title };
      const p = (await res.json()) as { title: string; extract: string; content_urls?: { desktop?: { page?: string } } };
      return { found: true, title: p.title, url: p.content_urls?.desktop?.page, summary: p.extract };
    }
  }),
  fetch_url: tool({
    description: "Fetch a web page and return its readable text (first 6,000 characters).",
    inputSchema: z.object({ url: z.string().url() }),
    execute: async ({ url }) => {
      const res = await fetch(url, { headers: UA, redirect: "follow" });
      const html = await res.text();
      const text = html
        .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return { url, status: res.status, text: text.slice(0, 6000) };
    }
  })
};

const MAX_STEPS = 10;

const UA = { "user-agent": "cloudflare-durable-agent-demo/1.0 (https://github.com/ShadowWalker2014/cloudflare-durable-agent)" };

/** The catalog the parent model chooses from — like Claude Code's subagent_type. */
export const SUBAGENT_TYPES: Record<
  SubAgentType,
  { label: string; model: ModelId; blurb: string; instructions: string; tools: (keyof typeof TOOLS)[] }
> = {
  researcher: {
    label: SUBAGENT_LABELS.researcher,
    model: "google/gemini-3.8-flash",
    blurb: "finds facts on the web and cites the pages it read",
    instructions:
      "You are a research sub-agent. Use wikipedia_search, then wikipedia_page or fetch_url on the best hits (2-4 reads). " +
      "Reply with 4-6 tight bullet points and a final line 'Sources:' with the URLs you actually read. Never invent a source.",
    tools: ["wikipedia_search", "wikipedia_page", "fetch_url"]
  },
  writer: {
    label: SUBAGENT_LABELS.writer,
    model: "anthropic/claude-haiku-4.5",
    blurb: "drafts and edits text; no tools",
    instructions: "You are a writing sub-agent. Produce exactly what the brief asks for, polished and ready to use. No preamble.",
    tools: []
  },
  "general-purpose": {
    label: SUBAGENT_LABELS["general-purpose"],
    model: "anthropic/claude-haiku-4.5",
    blurb: "multi-step tasks that may need to read web pages",
    instructions: "You are a general-purpose sub-agent. Work through the task step by step, use tools when useful, and end with a clear answer.",
    tools: ["fetch_url", "wikipedia_search", "wikipedia_page"]
  }
};

export class SubAgent extends LoggedChatAgent<SubAgentState> {
  initialState: SubAgentState = { type: "general-purpose", description: "" };

  /** The parent's tool input becomes this session's first user message. */
  protected override formatAgentToolInput(input: unknown, request: { runId: string }): UIMessage {
    const { prompt, description, subagent_type } = input as AgentToolInput;
    const type = SUBAGENT_TYPES[subagent_type] ? subagent_type : "general-purpose";
    this.setState({ type, description });
    this.log.write("info", "subagent", "run:start", { runId: request.runId, type, description });
    return { id: `task-${request.runId}`, role: "user", parts: [{ type: "text", text: prompt }] };
  }

  /**
   * What the parent receives. If a restart cut this run short after it had only
   * called tools, say so instead of returning an empty answer.
   */
  override getAgentToolOutput(_request: unknown, messages: UIMessage[]) {
    const assistant = messages.filter((m) => m.role === "assistant");
    const text = assistant.at(-1)?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("").trim();
    if (text) return text;
    const calls = assistant.flatMap((m) => m.parts.filter(isToolUIPart).map((p) => getToolName(p)));
    return `The sub-agent stopped before writing an answer (it was interrupted). It had run: ${calls.join(", ") || "nothing"}. Re-run it if you need the result.`;
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const config = SUBAGENT_TYPES[this.state.type] ?? SUBAGENT_TYPES["general-purpose"];
    const tools = Object.fromEntries(config.tools.map((name) => [name, TOOLS[name]]));
    this.log.write("info", "chat", "turn:start", { model: config.model, type: this.state.type });

    const result = streamText({
      model: gateway(config.model),
      abortSignal: options?.abortSignal,
      instructions: config.instructions,
      messages: await convertToModelMessages(this.messages, { tools }),
      tools,
      stopWhen: isStepCount(MAX_STEPS),
      // The last step may not call tools, so a busy sub-agent always ends with an answer.
      prepareStep: ({ stepNumber }) => (stepNumber === MAX_STEPS - 1 ? { toolChoice: "none" as const } : {}),
      onStepEnd: (step) =>
        this.log.write("info", "llm", "step:end", { finishReason: step.finishReason, toolCalls: step.toolCalls.map((c) => c.toolName), usage: step.usage }),
      onError: ({ error }) => this.log.write("error", "llm", "stream:error", { message: errorMessage(error) })
    });
    return result.toUIMessageStreamResponse({ onError: errorMessage });
  }
}
