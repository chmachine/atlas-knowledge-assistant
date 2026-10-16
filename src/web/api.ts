export interface User {
  id: string;
  username: string;
  display_name: string;
  role: "employee" | "it_ops" | "hr" | "finance";
  is_admin: boolean;
  /** Document access labels this user may read. */
  sees: string[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

/** JSON fetch helper. Every request carries the CSRF header the Worker requires on writes. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: { "X-KB": "1", ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error");
  return data as T;
}

export interface Source {
  n: number;
  chunkId: string;
  docId: string;
  anchor: string;
  title: string;
  section: string;
  url: string;
  ownerName: string;
  ownerRole: string;
  isLatest: boolean;
  injectionFlag: boolean;
  snippet: string;
}

export type Mode = "vector" | "agentic";

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
  steps: Step[];
  answer: string;
  refused: boolean;
  refusalReason: string | null;
  sources: Source[];
  injectionDetected: boolean;
  retrievedCount: number;
  latencyMs: number;
  quota: Quota | null;
}

export interface Quota {
  used: number;
  limit: number;
  resetsAt: string;
}

export interface SourceDoc {
  doc: {
    id: string;
    title: string;
    department: string;
    owner_name: string;
    owner_role: string;
    version: number;
    effective_date: string;
    is_latest: boolean;
    superseded_by: string | null;
    language: string;
  };
  sections: { anchor: string; section: string; text: string; injection_flag: boolean }[];
}

export interface AuditRow {
  id: string;
  created_at: string;
  username: string | null;
  role: string;
  mode: Mode;
  source: "live" | "simulated" | "eval";
  question: string;
  refused: 0 | 1;
  refusal_reason: string | null;
  injection_detected: 0 | 1;
  pii_redactions: number;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  model: string | null;
  fell_back: 0 | 1;
  feedback: -1 | 1 | null;
  error: string | null;
}

export interface AuditDetail extends AuditRow {
  answer: string;
  retrieved_chunk_ids: string[];
  cited_chunk_ids: string[];
  tool_calls: { step: number; tool: string; input: unknown; found: number; error?: string }[];
}

export interface Rate {
  pass: number;
  total: number;
}

export interface EvalSummary {
  n: number;
  errors: number;
  citation_correct: Rate;
  blocked_refused: Rate;
  leak_free: Rate;
  faithfulness_mean: number | null;
  avg_latency_s: number | null;
  avg_answer_cost_usd: number | null;
}

export interface Assumption {
  minutes_per_search: number;
  updated_by: string | null;
  updated_at: string | null;
}

export interface DashboardData {
  window: { days: number; from: string; to: string; includes_simulated: boolean; simulated_questions: number };
  totals: {
    questions: number;
    answered: number;
    answered_with_source: number;
    refused: number;
    failed: number;
    active_users: number;
    answered_with_source_rate: number | null;
    refusal_rate: number | null;
    thumbs: { up: number; down: number; up_rate: number | null };
    latency_s: { avg: number | null; p95: number | null };
    cost_usd: { total: number; per_question: number | null };
  };
  per_day: { day: string; questions: number; active_users: number }[];
  by_mode: { mode: Mode; questions: number; avg_latency_s: number | null; avg_cost_usd: number | null }[];
  time_saved: { minutes_per_search: number; answered: number; hours: number; assumption: Assumption };
  latest_eval: null | {
    run: { id: string; created_at: string; git_sha: string | null; model: string; judge_model: string; notes: string | null };
    vector: EvalSummary;
    agentic: EvalSummary;
  };
}
