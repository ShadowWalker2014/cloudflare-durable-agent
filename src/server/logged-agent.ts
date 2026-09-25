import { AIChatAgent } from "@cloudflare/ai-chat";
import { callable, type Connection, getCurrentAgent } from "agents";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { Observability } from "agents/observability";
import { AgentLog, type LogEntry } from "./logs";
import { limitMessage } from "./rate-limit";

/**
 * AIChatAgent + an event log you can open in the app. Both the main chat agent
 * and every sub-agent session extend this, so each session has its own logs.
 */
export class LoggedChatAgent<State = unknown> extends AIChatAgent<Env, State> {
  readonly log = new AgentLog(this);

  /** Route every SDK lifecycle event (connect, tool approval, recovery, tasks…) into the log. */
  override observability: Observability = {
    emit: (event) => {
      if (event.type === "rpc" && ["getLogs", "clearLogs"].includes((event.payload as { method?: string })?.method ?? "")) return;
      const level = event.type.includes("error") || event.type.includes("failed") ? "error" : "info";
      this.log?.write(level, "sdk", event.type, event.payload);
    }
  };

  /** Remember the visitor's IP on their socket (it survives hibernation), for rate limiting. */
  override onConnect(connection: Connection, ctx: { request: Request }) {
    const ip = ctx.request.headers.get("cf-connecting-ip") ?? "local";
    connection.setState({ ...((connection.state as object | null) ?? {}), ip });
  }

  /**
   * When the visitor who sent this turn is over the demo limits, returns the reply
   * to send instead: an error the chat shows with its usual error card. Turns the
   * server starts itself (sub-agent runs, recovery, background tasks) have no
   * connection and are not counted.
   */
  protected async rateLimitedResponse(): Promise<Response | null> {
    const { connection } = getCurrentAgent();
    if (!connection || this.env.DEMO_RATE_LIMIT === "false") return null;
    const ip = (connection.state as { ip?: string } | null)?.ip ?? "unknown";
    const verdict = await this.env.RATE_LIMITER.getByName(`ip:${ip}`).take();
    if (verdict.ok) return null;
    this.log.write("warn", "chat", "rate-limited", { ip, limit: verdict.limit });
    const errorText = limitMessage(verdict);
    return createUIMessageStreamResponse({ stream: createUIMessageStream({ execute: ({ writer }) => writer.write({ type: "error", errorText }) }) });
  }

  @callable()
  getLogs(): LogEntry[] {
    return this.log.list();
  }

  @callable()
  clearLogs() {
    this.log.clear();
  }
}

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}
