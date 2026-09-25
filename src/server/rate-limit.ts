import { DurableObject } from "cloudflare:workers";

/**
 * Per-visitor message limits for the public demo. One RateLimiter Durable
 * Object per client IP keeps that visitor's recent message timestamps.
 * Set DEMO_RATE_LIMIT to "false" (see .dev.vars.example) to switch it off.
 */
export const LIMITS = [
  { max: 20, windowMs: 60_000, label: "20 messages a minute" },
  { max: 50, windowMs: 5 * 60 * 60_000, label: "50 messages every 5 hours" }
];

export type Verdict = { ok: true } | { ok: false; limit: string; retryAfterSec: number };

export class RateLimiter extends DurableObject<Env> {
  async take(): Promise<Verdict> {
    const now = Date.now();
    const longest = Math.max(...LIMITS.map((l) => l.windowMs));
    const hits = ((await this.ctx.storage.get<number[]>("hits")) ?? []).filter((t) => now - t < longest);
    for (const l of LIMITS) {
      const inWindow = hits.filter((t) => now - t < l.windowMs);
      if (inWindow.length >= l.max) return { ok: false, limit: l.label, retryAfterSec: Math.ceil((inWindow[0] + l.windowMs - now) / 1000) };
    }
    hits.push(now);
    await this.ctx.storage.put("hits", hits);
    return { ok: true };
  }
}

export function limitMessage(v: Extract<Verdict, { ok: false }>) {
  const wait = v.retryAfterSec < 90 ? `${v.retryAfterSec} seconds` : `${Math.ceil(v.retryAfterSec / 60)} minutes`;
  return `This public demo allows ${v.limit} per visitor. Try again in ${wait}, or run it yourself from github.com/ShadowWalker2014/cloudflare-durable-agent.`;
}
