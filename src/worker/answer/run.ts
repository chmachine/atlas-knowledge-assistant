import type { ChunkRow } from "../retrieval/store";
import type { JsonBlock, LlmUsage } from "./llm";

// What either retrieval mode hands back to the shared answer pipeline in ask.ts.

export interface ToolCallLog {
  step: number;
  tool: string;
  /** What the model asked for. Redacted before it is logged or shown. */
  input: unknown;
  /** How many passages (or documents) the call returned. */
  found: number;
  chunkIds: string[];
  error?: string;
}

export interface ModelRun {
  /** The final assistant content blocks. */
  content: JsonBlock[];
  stopReason: string | null;
  /** Summed over every model call of the run. */
  usage: LlmUsage;
  model: string;
  fellBack: boolean;
  /** The chunks given to the model as search_result blocks, in order. A citation's index points into this list. */
  given: ChunkRow[];
  /** Chunks retrieval contributed (for the audit log and the retrieval-hit metric). The contacts directory is not counted. */
  relevantIds: string[];
  toolCalls: ToolCallLog[];
  /** Personal-data items removed from the text that went to the model. */
  redactions: number;
  /** Number of model calls. */
  steps: number;
}

/** A failure inside a run, with the stage it happened in, so the audit log can say what broke. */
export class RunError extends Error {
  constructor(
    public stage: "retrieval" | "model",
    message: string,
    public retrievedIds: string[] = [],
  ) {
    super(message);
  }
}

export const emptyUsage = (): LlmUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
export const addUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});
