import { gateway } from "ai";

/**
 * Every model goes through Vercel AI Gateway via `gateway()`: one key
 * (AI_GATEWAY_API_KEY), every provider, provider fallbacks and spend in one place.
 * https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway
 * https://vercel.com/docs/ai-gateway
 */
export const MODELS = [
  { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5" },
  { id: "openai/gpt-5.4-mini", name: "GPT-5.4 mini" },
  { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash" }
] as const;

export type ModelId = (typeof MODELS)[number]["id"];

export const DEFAULT_MODEL: ModelId = "anthropic/claude-sonnet-5";

/** The sub-agent uses a fast, cheap model; the orchestrator stays on the user's pick. */
export const SUBAGENT_MODEL: ModelId = "google/gemini-3.8-flash";

/** A model id that does not exist — used by the "Simulate error" switch in the UI. */
export const BROKEN_MODEL = "openai/model-that-does-not-exist";

export function resolveModel(requested: unknown) {
  const id = MODELS.some((m) => m.id === requested) ? (requested as ModelId) : DEFAULT_MODEL;
  return { id, model: gateway(id) };
}

export { gateway };
