import { MAX_QUESTION_CHARS } from "../../config";
import type { SessionUser } from "../env";
import { recordAudit } from "../governance/audit";
import { consumeQuota, type Quota } from "../governance/quota";
import { redact, redactDeep, redactText } from "../governance/redact";
import type { Embedder, VectorStore } from "../retrieval/ports";
import { runAgentic } from "./agentic";
import { parseAnswer, type SourceRef } from "./citations";
import { estimateCost } from "./cost";
import type { Llm } from "./llm";
import { GENERIC_DECLINED, GENERIC_NO_SOURCE } from "./prompts";
import { RunError, type ModelRun } from "./run";
import { runVector } from "./vectorMode";

export class BadQuestionError extends Error {}
export class NotConfiguredError extends Error {}
/** The model or retrieval failed. The failure is in the audit log under `auditId`; the caller gets no internals. */
export class UpstreamError extends Error {
  constructor(public auditId: string) {
    super("upstream failure");
  }
}

export interface AskDeps {
  db: D1Database;
  llm?: Llm;
  embedder?: Embedder;
  vectors?: VectorStore;
  now?: () => Date;
  /** Overrides the similarity threshold (tests use a fake embedder whose scores are on a different scale). */
  minSimilarity?: number;
}

export type Mode = "vector" | "agentic";

export interface AskInput {
  user: SessionUser;
  question: string;
  mode: Mode;
  ipHash: string;
  /** "eval" runs are not counted against the daily limits and are marked in the audit log. */
  source?: "live" | "eval";
}

/** One step of how the answer was found, shown to the user and stored in the audit log. Inputs are redacted. */
export interface Step {
  step: number;
  tool: string;
  input: unknown;
  found: number;
  error?: string;
}

export interface AskResult {
  auditId: string;
  mode: Mode;
  answer: string;
  refused: boolean;
  refusalReason: string | null;
  sources: SourceRef[];
  steps: Step[];
  /** A passage that looks like an instruction to an AI was among the retrieved text. */
  injectionDetected: boolean;
  retrievedCount: number;
  latencyMs: number;
  quota: Quota | null;
}

export async function ask(deps: AskDeps, input: AskInput): Promise<AskResult> {
  const { db } = deps;
  const started = Date.now();
  const question = input.question.trim();
  if (!question || question.length > MAX_QUESTION_CHARS) throw new BadQuestionError();
  // Agentic mode needs only the model and the database; vector mode also needs embeddings and the vector index.
  if (!deps.llm || (input.mode === "vector" && !(deps.embedder && deps.vectors))) throw new NotConfiguredError();
  const source = input.source ?? "live";
  const { user } = input;

  // Cost caps come first: nothing below runs, and nothing is spent, once a limit is reached.
  const quota = source === "eval" ? null : await consumeQuota(db, user.id, input.ipHash, deps.now?.());

  // Personal data is removed from the question before it is embedded, sent to the model or logged.
  const q = redact(question);
  const base = { userId: user.id, username: user.username, role: user.role, mode: input.mode, source, question: q.text } as const;

  let run: ModelRun;
  try {
    run =
      input.mode === "agentic"
        ? await runAgentic({ db, llm: deps.llm }, user.role, q.text)
        : await runVector({ db, llm: deps.llm, embedder: deps.embedder!, vectors: deps.vectors!, minSimilarity: deps.minSimilarity }, user.role, q.text);
  } catch (e) {
    if (!(e instanceof RunError)) throw e;
    const auditId = await recordAudit(db, { ...base, retrievedChunkIds: e.retrievedIds, refused: true, refusalReason: "error", error: `${e.stage}: ${e.message}`, latencyMs: Date.now() - started });
    throw new UpstreamError(auditId);
  }

  const parsed = parseAnswer(run.content, run.given);
  let answer = parsed.text;
  let sources = parsed.sources;
  let refused = false;
  let reason: string | null = null;
  if (run.stopReason === "refusal") {
    [refused, reason, answer, sources] = [true, "model_refusal", GENERIC_DECLINED, []];
  } else if (run.stopReason === "max_tokens") {
    [refused, reason, answer, sources] = [true, "max_tokens", GENERIC_DECLINED, []];
  } else if (run.stopReason === "max_steps") {
    [refused, reason, answer, sources] = [true, "max_steps", GENERIC_DECLINED, []];
  } else if (parsed.noAnswer) {
    [refused, reason, answer] = [true, "no_answer", parsed.text || GENERIC_NO_SOURCE];
  } else if (parsed.sources.length === 0) {
    // "Answer only from sources" is enforced here, not just requested in the prompt: no verified citation, no answer.
    [refused, reason, answer, sources] = [true, "uncited", GENERIC_NO_SOURCE, []];
  }
  answer = redactText(answer);

  const steps: Step[] = run.toolCalls.map((t) => ({ step: t.step, tool: t.tool, input: redactDeep(t.input), found: t.found, ...(t.error ? { error: redactText(t.error) } : {}) }));
  const injectionDetected = run.given.some((c) => c.injection_flag);
  const { costUsd } = estimateCost(run.model, run.usage);
  const latencyMs = Date.now() - started;
  const auditId = await recordAudit(db, {
    ...base,
    retrievedChunkIds: run.relevantIds,
    citedChunkIds: sources.map((s) => s.chunkId),
    toolCalls: run.toolCalls,
    answer,
    refused,
    refusalReason: reason,
    injectionDetected,
    piiRedactions: q.total + run.redactions,
    latencyMs,
    inputTokens: run.usage.inputTokens,
    outputTokens: run.usage.outputTokens,
    cacheReadTokens: run.usage.cacheReadTokens,
    costUsd,
    model: run.model,
    fellBack: run.fellBack,
  });

  return { auditId, mode: input.mode, answer, refused, refusalReason: reason, sources, steps, injectionDetected, retrievedCount: run.relevantIds.length, latencyMs, quota };
}
