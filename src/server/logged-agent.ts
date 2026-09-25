import { AIChatAgent } from "@cloudflare/ai-chat";
import { callable } from "agents";
import type { Observability } from "agents/observability";
import { AgentLog, type LogEntry } from "./logs";

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
