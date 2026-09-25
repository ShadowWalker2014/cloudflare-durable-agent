import type { Agent } from "agents";

/**
 * A per-agent event log you can open in the app. Each entry is written to the
 * agent's own SQLite database and pushed live to every connected browser.
 *
 * In production also use Workers Logs and `wrangler tail`:
 * https://developers.cloudflare.com/workers/observability/logs/workers-logs/
 * https://developers.cloudflare.com/agents/api-reference/observability/
 */
export type LogLevel = "info" | "warn" | "error";

export type LogEntry = {
  id: number;
  ts: number;
  level: LogLevel;
  source: string;
  event: string;
  data?: unknown;
};

/** WebSocket frame type the client listens for. */
export const LOG_FRAME = "app:log";
const KEEP = 500;

type AnyAgent = Agent<Cloudflare.Env, unknown>;

export class AgentLog {
  #ready = false;

  constructor(private readonly agent: AnyAgent) {}

  write(level: LogLevel, source: string, event: string, data?: unknown) {
    this.#ensure();
    const ts = Date.now();
    const json = data === undefined ? null : JSON.stringify(data, truncate);
    const [row] = this.agent.sql<{ id: number }>`
      INSERT INTO app_logs (ts, level, source, event, data) VALUES (${ts}, ${level}, ${source}, ${event}, ${json})
      RETURNING id`;
    this.agent.sql`DELETE FROM app_logs WHERE id <= ${row.id - KEEP}`;
    const entry: LogEntry = { id: row.id, ts, level, source, event, data };
    this.agent.broadcast(JSON.stringify({ type: LOG_FRAME, entry }));
    // Mirror to the Worker's console so `wrangler tail` and Workers Logs see it too.
    const line = `[${source}] ${event}${json ? ` ${json}` : ""}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  list(limit = 200): LogEntry[] {
    this.#ensure();
    const rows = this.agent.sql<Omit<LogEntry, "data"> & { data: string | null }>`
      SELECT id, ts, level, source, event, data FROM app_logs ORDER BY id DESC LIMIT ${limit}`;
    return rows.reverse().map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : undefined }));
  }

  clear() {
    this.#ensure();
    this.agent.sql`DELETE FROM app_logs`;
  }

  #ensure() {
    if (this.#ready) return;
    this.agent.sql`CREATE TABLE IF NOT EXISTS app_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL,
      source TEXT NOT NULL, event TEXT NOT NULL, data TEXT)`;
    this.#ready = true;
  }
}

function truncate(_key: string, value: unknown) {
  if (typeof value === "string" && value.length > 600) return `${value.slice(0, 600)}… (${value.length} chars)`;
  return value;
}
