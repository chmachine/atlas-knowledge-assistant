import { CLAUDE_MODEL, PRICING_USD_PER_MTOK } from "../../config";
import type { LlmUsage } from "./llm";

/** Estimated cost in USD at list prices. An unknown model (for example a fallback) is priced like the configured one and flagged. */
export function estimateCost(model: string, usage: LlmUsage): { costUsd: number; priceKnown: boolean } {
  const known = PRICING_USD_PER_MTOK[model];
  const price = known ?? PRICING_USD_PER_MTOK[CLAUDE_MODEL]!;
  const usd =
    (usage.inputTokens * price.input + usage.outputTokens * price.output + usage.cacheReadTokens * price.cacheRead + usage.cacheWriteTokens * price.cacheWrite) / 1_000_000;
  return { costUsd: Math.round(usd * 1e6) / 1e6, priceKnown: Boolean(known) };
}
