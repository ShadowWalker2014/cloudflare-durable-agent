---
name: cloudflare-durable-agent
description: Build a durable AI agent on Cloudflare — Workers + Durable Objects + Agents SDK (@cloudflare/ai-chat) + AI SDK with Vercel AI Gateway `gateway()` + AI Elements UI. Covers streaming, resumable streams, crash/deploy recovery, tools, human-in-the-loop approvals, sub-agents, durable background tasks (the Cloudflare answer to Vercel Workflow step.do), forking chats, image/file attachments on R2, error display + retry, per-agent logs, multi-thread chat, deploy. Use when starting or extending any AI agent / chat app hosted on Cloudflare, or when porting a Vercel Workflow / Vercel AI agent to Cloudflare.
---

# Durable agents on Cloudflare — the playbook

A working reference lives in the repo this skill ships with
(`github.com/ShadowWalker2014/cloudflare-durable-agent`). Copy its shape; every
pattern below is running code there, checked by `bun run e2e`.

## When to reach for this

Pick this stack when you want **long-running agents on serverless edge
hosting**. A plain serverless function is stateless and short-lived, so an agent
built on one needs a database, a queue, a workflow engine and a stream store
bolted on. Here each agent *is* a Durable Object: a stateful, addressable
instance with its own SQLite, WebSockets, alarms and a durable step journal.
Chats survive a refresh, turns survive a deploy, jobs keep running after the tab
closes, and humans can approve actions mid-run. Everything deploys as **one
Worker** (UI assets + API + agents); nothing else to host.

## The shape

```
Browser (React + AI Elements)
  │  one WebSocket per open chat  (useAgent + useAgentChat)
  ▼
Worker  src/server/index.ts
  ├─ /agents/chat-agent/<threadId>   → ChatAgent       (1 Durable Object per conversation)
  │     ├─ SQLite: messages, stream chunks, logs, task journal
  │     ├─ facet → SubAgent/<runId>   (one per sub-agent run: own transcript, tools, logs;
  │     │                               open it at /agents/chat-agent/<id>/sub/sub-agent/<runId>)
  │     └─ taskDefinitions            (durable background jobs)
  ├─ /agents/thread-index/<userId>   → ThreadIndex     (1 per user: threads, forks, sub-agent sessions)
  ├─ /api/files                      → R2 bucket FILES (attachments)
  └─ static assets (Vite build of the React app)

LLM calls: AI SDK `streamText({ model: gateway("anthropic/claude-sonnet-5") })`
           → Vercel AI Gateway → any provider, one key
```

Rule of thumb: **one Durable Object per unit of conversation state** (a chat), plus
**one small index DO per user** for listing. Never put many chats in one DO.

## Stack (pinned versions that are known to work together)

| Package | Version | Why |
| --- | --- | --- |
| `agents` | 0.24 | Agent base class, routing, `@callable`, tasks, sub-agents, observability |
| `@cloudflare/ai-chat` | 0.12 | `AIChatAgent` (server) + `useAgentChat` (client) |
| `ai` | **7.0.60 exact** (+ `@ai-sdk/react` 4.0.63) | `streamText`, `tool`, `gateway()`, `Output.object`. Pinned: see the first gotcha |
| `@cloudflare/vite-plugin` + `vite` 8 | 1.60 | runs Worker + DOs in workerd during `vite dev` |
| `agents/vite` plugin | — | compiles `@callable()` decorators (Vite's Oxc cannot) |
| AI Elements (shadcn registry) | latest | chat UI components copied into `src/components/ai-elements` |
| Tailwind 4, `motion` | — | tokens + springs |

## Start a new project

```bash
mkdir my-agent && cd my-agent && bun init -y
bun add --exact ai@7.0.60 @ai-sdk/react@4.0.63
bun add agents @cloudflare/ai-chat zod react react-dom nanoid motion lucide-react
bun add -d wrangler vite @cloudflare/vite-plugin @vitejs/plugin-react @tailwindcss/vite tailwindcss typescript @cloudflare/workers-types
bunx --bun ai-elements@latest add conversation message prompt-input attachments tool confirmation reasoning shimmer
echo 'AI_GATEWAY_API_KEY=...' > .dev.vars      # never commit
bunx wrangler types env.d.ts --include-runtime false   # re-run after every wrangler.jsonc change
```

Copy `vite.config.ts`, `wrangler.jsonc`, `tsconfig.json` from the reference repo. Key bits:

```ts
// vite.config.ts
plugins: [agents(), react(), cloudflare(), tailwindcss()]
```

```jsonc
// wrangler.jsonc
"compatibility_flags": ["nodejs_compat"],            // also fills process.env → gateway() finds its key
"assets": { "not_found_handling": "single-page-application", "run_worker_first": ["/agents/*", "/api/*"] },
"durable_objects": { "bindings": [{ "name": "ChatAgent", "class_name": "ChatAgent" }, { "name": "ThreadIndex", "class_name": "ThreadIndex" }] },
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["ChatAgent", "ThreadIndex"] }],   // SQLite storage is required
"r2_buckets": [{ "binding": "FILES", "bucket_name": "my-agent-files" }],
"observability": { "enabled": true }
```

## Pattern 1 — the chat agent (streaming, persistence, resume, recovery for free)

```ts
export class ChatAgent extends AIChatAgent<Env, ChatState> {
  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const body = (options?.body ?? {}) as { model?: string };
    const result = streamText({
      model: gateway(body.model ?? "anthropic/claude-sonnet-5"),
      abortSignal: options?.abortSignal,              // Stop button cancels the model call
      instructions: "…",
      messages: await convertToModelMessages(this.messages, { tools }),
      tools,
      reasoning: "low",                               // AI SDK 7: provider-neutral reasoning effort
      stopWhen: isStepCount(8)
    });
    return result.toUIMessageStreamResponse({ sendReasoning: true, onError: (e) => String((e as Error).message ?? e) });
  }
}
```

What `AIChatAgent` already does — do not rebuild it:
- persists messages in the DO's SQLite, syncs every tab over the WebSocket;
- buffers stream chunks, so a refresh / flaky network **resumes mid-stream** (`useAgentChat` `resume: true` by default);
- runs every turn in a durable fiber: after a deploy or eviction it **recovers** the turn (`onChatRecovery`, `chatRecovery` budgets — set them as class fields, never in `onStart`);
- `messageConcurrency` for overlapping sends; `maxPersistedMessages`; row-size compaction.

Client:

```tsx
const agent = useAgent<ChatState>({ agent: "ChatAgent", name: threadId, onStateUpdate: setState });
const chat = useAgentChat({ agent, body: () => ({ model }) });   // body as a function = latest values
// chat: messages, sendMessage, status, error, regenerate, stop, clearError,
//       addToolApprovalResponse, isRecovering, isServerStreaming
```

## Pattern 2 — tools, and human in the loop

```ts
sendEmail: tool({
  description: "Send an email. Always requires approval.",
  inputSchema: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
  needsApproval: true,                 // or (input) => input.amount > 100
  execute: async (input) => send(input)
})
```

The turn parks with the tool part in `approval-requested`. Render AI Elements
`<Confirmation approval={part.approval} state={part.state}>` and call
`addToolApprovalResponse({ id: part.approval.id, approved })`. The conversation
auto-continues. A parked approval survives deploys (recovery never seals a turn
that is waiting on a human).

Client-side tools (browser APIs): define the tool **without** `execute` and
answer in `useAgentChat({ onToolCall })` with `addToolOutput`.

## Pattern 3 — sub-agents as real sessions (the Claude Code `Task` model)

Give the parent **one generic `agent` tool**, not one tool per helper. The model
picks a sub-agent type, writes a short description and a complete brief, and can
run several in parallel or send one to the background:

```ts
agent: tool({
  description: "Launch a sub-agent for a self-contained task. It starts with no context — the prompt must be a complete brief.",
  inputSchema: z.object({
    description: z.string().describe("3-6 word label shown in the UI"),
    prompt: z.string(),
    subagent_type: z.enum(["researcher", "writer", "general-purpose"]),
    run_in_background: z.boolean().optional()
  }),
  execute: async (input, { toolCallId, abortSignal }) => {
    const base = { input, parentToolCallId: toolCallId, display: { name: LABELS[input.subagent_type], description: input.description } };
    if (input.run_in_background) {
      const run = await this.runAgentTool(SubAgent, { ...base, detached: { notify: { source: "subagent" } } });
      return { runId: run.runId, status: "running in the background — you will be messaged when it finishes" };
    }
    const run = await this.runAgentTool(SubAgent, { ...base, signal: abortSignal });
    return run.status === "completed" ? { runId: run.runId, result: run.summary } : { runId: run.runId, status: run.status, error: run.error };
  }
})
```

One `SubAgent extends AIChatAgent` class serves every type: a catalog maps
`subagent_type` → model, instructions and tools, and `formatAgentToolInput`
stores the type in state and turns the prompt into the first user message.

Each run is a **facet** — a child Durable Object named by `runId`, with its own
SQLite transcript, logs and resumable stream. No wrangler binding, no migration;
just `export` the class from the worker entry. That makes it a normal session:

- **Live in the parent**: `useAgentToolEvents({ agent }).getRunsForToolCall(part.toolCallId)` streams the child's parts into the tool card; runs replay after refresh.
- **Listed**: `onAgentToolStart` / `onAgentToolFinish` on the parent record `{runId, threadId, type, description, status}` in the per-user index, so the sidebar nests sessions under their thread.
- **Openable**: the client connects straight to the child with `useAgent({ agent: "ChatAgent", name: threadId, sub: [{ agent: "SubAgent", name: runId }] })` and reuses the same chat view — transcript, tool calls, logs, and a composer to keep talking to it.
- **Background**: `detached.notify` appends a message to the parent when the run ends (tag it via `metadata.source`).

Gate who may open a child:

```ts
override async onBeforeSubAgent(_req, child) {
  if (!this.hasAgentToolRun(child.className, child.name)) return new Response("Not found", { status: 404 });
}
```

For a quick in-process helper with no storage or UI, an AI SDK `ToolLoopAgent` inside a tool is enough.

## Pattern 4 — durable background tasks (≈ Vercel Workflow)

```ts
override readonly taskDefinitions = {
  "report@v1": async (input: { topic: string; runId: string }, step: TaskStep) => {
    const outline = await step.do("outline", { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" } }, () => makeOutline(input.topic));
    await step.sleep("cool-down", "3 seconds");        // no isolate stays awake
    for (const [i, h] of outline.entries()) await step.do(`section:${i}`, () => write(h));
    await step.do("publish", async () => {
      await this.waitUntilStable({ timeout: 60_000 });  // never write over a live stream
      await this.persistMessages([...this.messages, reportMessage]);
    });
  }
} satisfies TaskHandlers;

// start it (from a tool, callable, schedule…):
await this.tasks.run("report@v1", { topic, runId }, { runId });   // idempotent by runId
```

| Vercel Workflow | Cloudflare Agents |
| --- | --- |
| `"use workflow"` function | entry in `taskDefinitions` (version the name: `report@v1`) |
| `"use step"` / `step.do` | `step.do(name, config?, fn)` — journaled, retried |
| `sleep("1h")` | `step.sleep(name, "1 hour")` / `step.sleepUntil` |
| hook / webhook resume | `needsApproval` in chat, or `step.waitForEvent` in Cloudflare Workflows |
| run id | `runId` / `idempotencyKey` on `tasks.run` |
| `start()` returns handle | `tasks.run()` returns a receipt; `tasks.get / list / cancel` |
| separate queue/runtime | runs inside the agent's own Durable Object alarm |

Replay rules: the handler re-runs from the top after any restart; completed steps
return their saved result. Put **every side effect inside `step.do`**, give loop
steps stable names, and treat a step as at-least-once (pass its `idempotencyKey`
to external APIs). Push progress to the UI with `this.setState(...)` — `useAgent`'s
`onStateUpdate` receives it live. For cross-service orchestration with a dashboard,
use Cloudflare Workflows (`this.runWorkflow`) instead.

## Pattern 5 — threads and forking

- `ThreadIndex extends Agent<Env, { threads }>` keyed by user id; `@callable createThread / renameThread / deleteThread`; its state syncs to every tab.
- **Fork** = copy history up to a message into a brand-new ChatAgent, listed like any other chat and titled `<name> (Forked)`:
  `source.exportUntil(messageId)` → `createThread()` → `target.importHistory(msgs)` (which calls `persistMessages`). Keep `parentId` as metadata only.
- `deleteThread` calls `chat.destroy()` to wipe that DO's storage.
- DO-to-DO calls: `const stub = await getAgentByName(this.env.ChatAgent, id); await stub.method()` (any public method, structured-clone args).

## Pattern 6 — attachments (images, PDFs, text files)

Store files in **R2**, send only a URL in the message:
1. AI Elements `PromptInput` hands `onSubmit` data URLs → client `POST /api/files?name=…` (body = blob) → `{ url: "/api/files/<key>" }`.
2. `sendMessage({ text, files: [{ type: "file", url, mediaType, filename }] })`.
3. Server, before `convertToModelMessages`: load each `/api/files/…` from R2; images/PDFs → `data:` URL file parts, text files → a text part (most models reject `text/*` file parts).

## Pattern 7 — errors and retry

- `toUIMessageStreamResponse({ onError })` — by default the SDK hides error text; return the message so users see what failed.
- Client: `error` from `useAgentChat` → show an alert with **Retry** = `clearError(); regenerate()`.
- `onChatResponse(result)` fires on `completed | error | aborted` — log it.

## Pattern 8 — logs you can examine

- Override `observability = { emit(event) { … } }` on the agent to capture every SDK lifecycle event (connect, tool approval, task steps, recovery…).
- Write app events (turn start, `onStepEnd` usage, tool calls, task progress) to a small SQLite table in the agent, `this.broadcast()` each line, and `@callable getLogs()` for backfill. The reference repo's `AgentLog` does this in 60 lines, and mirrors to `console.*`.
- Production: `wrangler tail`, Workers Logs (`observability.enabled`), Tail Workers read `diagnosticsChannelEvents`, and `wrapAISDK` from `agents/observability/ai` for OpenTelemetry GenAI spans.

## Deploy

```bash
bunx wrangler r2 bucket create my-agent-files
bunx wrangler secret put AI_GATEWAY_API_KEY
bun run deploy            # vite build && wrangler deploy
bunx wrangler tail        # live logs
```

Add auth before shipping: check a session in the Worker before `routeAgentRequest`
(or `onBeforeConnect` / `onBeforeRequest` on the agent) and derive `userId` from it,
never from the client.

## Gotchas (each one cost time)

- **Pin `ai@7.0.60` and `@ai-sdk/react@4.0.63` (exact).** From `ai@7.0.61`, `Chat.resumeStream()` starts from an empty message instead of the last assistant message. `useAgentChat` delivers the post-approval continuation through `resumeStream()`, so every **Approve** ends in `No tool invocation found for tool call ID …` (the tool still runs; the UI shows an error). Upstream: https://github.com/vercel/ai/issues/18107. Re-test approvals before bumping `ai`.

- `@callable()` needs the `agents/vite` plugin and `extends: "agents/tsconfig"`.
- Every DO class, including facet sub-agents, must be **exported** from the worker entry. Facets need no binding and no migration.
- Anthropic Sonnet 5 / Opus 5+ reject `thinking.type: "enabled"` → use AI SDK 7's top-level `reasoning: "low"`.
  OpenAI/Google only stream readable reasoning with `reasoningSummary: "auto"` / `thinkingConfig.includeThoughts`.
- AI SDK 7 renames: `instructions` (not `system`), `isStepCount` (not `stepCountIs`), `onStepEnd`, `Output.object` (no `generateObject`).
- `isToolUIPart` now includes dynamic tools; use `isStaticToolUIPart` before reading `part.type`-based names.
- `taskDefinitions` names starting with `__cf` are reserved for the framework (chat turns run as `__cf_internal_chat_turn`).
- Write to the transcript from background work only after `await this.waitUntilStable({ timeout })`.
- AI Elements `PromptInput` calls `form.reset()` on submit unless wrapped in `PromptInputProvider`; the reset also snaps a Radix `Select` in the form (model picker) back to its first option. Wrap the composer in the provider.
- Autoscroll a log pane by setting its `scrollTop`; `scrollIntoView` also scrolls every scrollable ancestor (sidebar, page).
- **Throwing inside `onChatMessage` leaves the browser stuck on "Thinking…"** — no terminal frame is sent. To refuse a turn (rate limit, auth), return `createUIMessageStreamResponse({ stream: createUIMessageStream({ execute: ({ writer }) => writer.write({ type: "error", errorText }) }) })`; the client shows it like any model error.
- **`stub.destroy()` over RPC resets the callee Durable Object on Cloudflare and breaks the call** (works locally). Update your own state first, then `await stub.destroy().catch(...)`.
- Public deploy: rate-limit per visitor IP with one tiny Durable Object per IP (`src/server/rate-limit.ts`); read the IP from `cf-connecting-ip` in `onConnect`, keep it in `connection.setState`, and count only turns that have a connection (`getCurrentAgent().connection`) so sub-agent runs, recovery and tasks are free. Give each browser its own anonymous workspace id.
- `chatRecovery` must be a class field or set in the constructor, never in `onStart()`.
- Vite "504 Outdated Optimize Dep" after adding UI deps → delete `node_modules/.vite` and list heavy deps in `optimizeDeps.include`.
- `nodejs_compat` + a 2025-04-01+ compatibility date fills `process.env` from vars and secrets, so `gateway()` works without passing the key.

## Scale and limits

- A DO is single-threaded: great for one chat, wrong for a global hot spot — shard by user/thread.
- 128 MB memory per DO isolate; up to 10 GB SQLite per DO — keep files in R2, prune what the model sees (`pruneMessages`).
- Idle DOs hibernate (WebSockets stay connected); you pay for wall time only while working.

## Reference

- Cloudflare Agents: https://developers.cloudflare.com/agents/
- Agents API: https://developers.cloudflare.com/agents/api-reference/agents-api/
- Chat agents: https://developers.cloudflare.com/agents/api-reference/chat-agents/ · source docs https://github.com/cloudflare/agents/blob/main/docs/agents/chat-agents.md
- Resumable streaming: https://github.com/cloudflare/agents/blob/main/docs/agents/resumable-streaming.md
- Human in the loop: https://developers.cloudflare.com/agents/concepts/human-in-the-loop/
- Sub-agents / agent tools: https://developers.cloudflare.com/agents/api-reference/sub-agents/ · https://developers.cloudflare.com/agents/api-reference/agent-tools/
- Tasks (durable steps): https://github.com/cloudflare/agents/blob/main/docs/agents/tasks.md · durable execution https://developers.cloudflare.com/agents/api-reference/durable-execution/
- Long-running agents: https://github.com/cloudflare/agents/blob/main/docs/agents/long-running-agents.md
- State sync: https://developers.cloudflare.com/agents/api-reference/store-and-sync-state/
- Routing: https://developers.cloudflare.com/agents/api-reference/routing/
- Observability: https://developers.cloudflare.com/agents/api-reference/observability/ · Workers Logs https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- Scheduling: https://developers.cloudflare.com/agents/api-reference/schedule-tasks/
- Durable Objects: https://developers.cloudflare.com/durable-objects/
- R2 from Workers: https://developers.cloudflare.com/r2/api/workers/workers-api-usage/
- Vite plugin: https://developers.cloudflare.com/workers/vite-plugin/
- AI SDK: https://ai-sdk.dev/docs/introduction · AI Gateway provider https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway · https://vercel.com/docs/ai-gateway
- AI Elements: https://ai-sdk.dev/elements
- Examples: https://github.com/cloudflare/agents/tree/main/examples
