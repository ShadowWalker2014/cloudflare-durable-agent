import type { JSONValue } from "ai";

type ProviderOptions = Record<string, Record<string, JSONValue>>;

/**
 * AI SDK 7 sets reasoning effort for every provider with one option
 * (`reasoning: "low"` on streamText). These extras only ask OpenAI and Google
 * to also stream a readable summary of that reasoning, so the UI can show it.
 * https://ai-sdk.dev/docs/ai-sdk-core/provider-options
 */
export function reasoningSummaryOptions(modelId: string): ProviderOptions | undefined {
  if (modelId.startsWith("openai/")) return { openai: { reasoningSummary: "auto" } };
  if (modelId.startsWith("google/")) return { google: { thinkingConfig: { includeThoughts: true } } };
  return undefined;
}
