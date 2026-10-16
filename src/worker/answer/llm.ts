import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL } from "../../config";

// The model as a small port. Tests plug in a scripted fake; production uses the Anthropic SDK.
// Content blocks are passed through untouched (including thinking blocks), because a tool loop has to send them back as they came.

export type JsonBlock = { type: string } & Record<string, unknown>;
export interface LlmMessage {
  role: "user" | "assistant";
  content: string | JsonBlock[];
}
export interface LlmTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
export type Effort = "low" | "medium" | "high";

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  maxTokens: number;
  effort: Effort;
  /** "none" forbids tool calls for this request (used on the last agent step). Forced tool use is rejected by Sonnet 5.5, so it is not offered. */
  toolChoice?: "auto" | "none";
}
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
export interface LlmResponse {
  content: JsonBlock[];
  stopReason: string | null;
  usage: LlmUsage;
  /** The model that actually answered. A server-side fallback can make it differ from the configured one. */
  model: string;
  fellBack: boolean;
}
export interface Llm {
  create(req: LlmRequest): Promise<LlmResponse>;
}

type BetaClient = Pick<Anthropic, "beta">;

/**
 * Claude through the Anthropic SDK.
 *  - Sonnet 5.5 always thinks (adaptive); depth is steered with `effort`. We send no `thinking`, `temperature` or `tool_choice`
 *    (forced tool use and sampling parameters are rejected on this model).
 *  - `fallbacks: "default"` lets the API re-run a request on a substitute model if the safety classifiers decline it.
 */
export function anthropicLlm(apiKey: string, opts: { model?: string; client?: BetaClient } = {}): Llm {
  const model = opts.model ?? CLAUDE_MODEL;
  const client: BetaClient = opts.client ?? new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
  return {
    async create(req) {
      const res = await client.beta.messages.create({
        model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.messages as never,
        ...(req.tools?.length ? { tools: req.tools as never } : {}),
        ...(req.toolChoice === "none" ? { tool_choice: { type: "none" as const } } : {}),
        output_config: { effort: req.effort },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      const iterations = (res.usage as unknown as { iterations?: { type: string }[] }).iterations ?? [];
      return {
        content: res.content as unknown as JsonBlock[],
        stopReason: res.stop_reason,
        usage: {
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
          cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
        },
        model: res.model,
        fellBack: iterations.some((i) => i.type === "fallback_message"),
      };
    },
  };
}
