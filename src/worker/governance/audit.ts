import { newId } from "../util/crypto";
import { redactDeep, redactText } from "./redact";

export interface AuditEntry {
  userId: string | null;
  username: string | null;
  role: string;
  mode: "vector" | "agentic";
  source?: "live" | "simulated" | "eval";
  question: string;
  retrievedChunkIds?: string[];
  citedChunkIds?: string[];
  toolCalls?: unknown[];
  answer?: string;
  refused?: boolean;
  refusalReason?: string | null;
  injectionDetected?: boolean;
  piiRedactions?: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  model?: string;
  fellBack?: boolean;
  error?: string | null;
  createdAt?: Date;
}

/**
 * Writes one audit row and returns its id. Redaction is applied here, to every text field, as the last step before the write:
 * whatever a caller forgot, personal data does not reach the log.
 */
export async function recordAudit(db: D1Database, e: AuditEntry): Promise<string> {
  const id = newId();
  await db
    .prepare(
      `INSERT INTO audit_log (id, created_at, user_id, username, role, mode, source, question, retrieved_chunk_ids, cited_chunk_ids, tool_calls, answer,
         refused, refusal_reason, injection_detected, pii_redactions, latency_ms, input_tokens, output_tokens, cache_read_tokens, cost_usd, model, fell_back, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      (e.createdAt ?? new Date()).toISOString(),
      e.userId,
      e.username,
      e.role,
      e.mode,
      e.source ?? "live",
      redactText(e.question),
      JSON.stringify(e.retrievedChunkIds ?? []),
      JSON.stringify(e.citedChunkIds ?? []),
      JSON.stringify(redactDeep(e.toolCalls ?? [])),
      redactText(e.answer ?? ""),
      e.refused ? 1 : 0,
      e.refusalReason ?? null,
      e.injectionDetected ? 1 : 0,
      e.piiRedactions ?? 0,
      e.latencyMs ?? null,
      e.inputTokens ?? null,
      e.outputTokens ?? null,
      e.cacheReadTokens ?? null,
      e.costUsd ?? null,
      e.model ?? null,
      e.fellBack ? 1 : 0,
      e.error ? redactText(e.error).slice(0, 500) : null,
    )
    .run();
  return id;
}
