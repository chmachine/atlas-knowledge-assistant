import { summarize, type EvalResultRow, type EvalRunRow, type Summary } from "../eval/report";
import { getAssumption, type Assumption } from "./settings";

// Adoption numbers for the admin dashboard, computed from the audit log. Everything here is an aggregate: no question, answer or
// document text leaves this module.
//
// Population: rows from real visitors and (optionally) simulated history, in the last N UTC days including today. Eval runs are never
// counted. Each row is exactly one of:
//   failed    the assistant could not answer (an upstream error); it is not counted as answered or refused
//   refused   no supported answer was given
//   answered  an answer was given
// "Answered with a source" is answered rows that carry at least one citation. The guardrails make that all of them, so it should
// equal "answered"; if it ever does not, the dashboard shows the gap.

export const DEFAULT_DAYS = 14;
export const MAX_DAYS = 60;

export interface DayPoint {
  day: string;
  questions: number;
  active_users: number;
}

export interface ModeStats {
  mode: "vector" | "agentic";
  questions: number;
  avg_latency_s: number | null;
  avg_cost_usd: number | null;
}

export interface Dashboard {
  window: { days: number; from: string; to: string; includes_simulated: boolean; simulated_questions: number };
  totals: {
    questions: number;
    answered: number;
    answered_with_source: number;
    refused: number;
    failed: number;
    active_users: number;
    /** Share of non-failed questions, 0 to 1. Null when there are none. */
    answered_with_source_rate: number | null;
    refusal_rate: number | null;
    thumbs: { up: number; down: number; up_rate: number | null };
    latency_s: { avg: number | null; p95: number | null };
    cost_usd: { total: number; per_question: number | null };
  };
  per_day: DayPoint[];
  by_mode: ModeStats[];
  time_saved: { minutes_per_search: number; answered: number; hours: number; assumption: Assumption };
  latest_eval: null | { run: Pick<EvalRunRow, "id" | "created_at" | "git_sha" | "model" | "judge_model" | "notes">; vector: Summary; agentic: Summary };
}

const dayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);
const secs = (ms: number | null): number | null => (ms === null ? null : ms / 1000);

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

export async function buildDashboard(db: D1Database, opts: { days?: number; includeSimulated?: boolean; now?: Date } = {}): Promise<Dashboard> {
  const days = Math.min(Math.max(Math.trunc(opts.days ?? DEFAULT_DAYS), 1), MAX_DAYS);
  const includeSimulated = opts.includeSimulated ?? true;
  const today = dayStart(opts.now ?? new Date());
  const from = addDays(today, -(days - 1));
  const to = addDays(today, 1); // exclusive
  const sources = includeSimulated ? ["live", "simulated"] : ["live"];
  const where = `source IN (${sources.map(() => "?").join(", ")}) AND created_at >= ? AND created_at < ?`;
  const params = [...sources, from.toISOString(), to.toISOString()];

  const overall = await db
    .prepare(
      `SELECT COUNT(*) AS questions,
         COALESCE(SUM(error IS NOT NULL), 0) AS failed,
         COALESCE(SUM(error IS NULL AND refused = 1), 0) AS refused,
         COALESCE(SUM(error IS NULL AND refused = 0), 0) AS answered,
         COALESCE(SUM(error IS NULL AND refused = 0 AND cited_chunk_ids <> '[]'), 0) AS answered_with_source,
         COUNT(DISTINCT user_id) AS active_users,
         COALESCE(SUM(feedback = 1), 0) AS up,
         COALESCE(SUM(feedback = -1), 0) AS down,
         AVG(CASE WHEN error IS NULL THEN latency_ms END) AS avg_latency_ms,
         COALESCE(SUM(cost_usd), 0) AS cost_usd,
         COUNT(cost_usd) AS costed,
         COALESCE(SUM(source = 'simulated'), 0) AS simulated
       FROM audit_log WHERE ${where}`,
    )
    .bind(...params)
    .first<Record<string, number | null>>();
  const n = (k: string) => Number(overall?.[k] ?? 0);

  const latencies = (
    await db.prepare(`SELECT latency_ms FROM audit_log WHERE ${where} AND error IS NULL AND latency_ms IS NOT NULL ORDER BY latency_ms`).bind(...params).all<{ latency_ms: number }>()
  ).results.map((r) => r.latency_ms);

  const perDayRows = (
    await db.prepare(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS questions, COUNT(DISTINCT user_id) AS active_users FROM audit_log WHERE ${where} GROUP BY day`).bind(...params).all<DayPoint>()
  ).results;
  const byDay = new Map(perDayRows.map((r) => [r.day, r]));
  const per_day: DayPoint[] = Array.from({ length: days }, (_, i) => {
    const day = addDays(from, i).toISOString().slice(0, 10);
    return { day, questions: byDay.get(day)?.questions ?? 0, active_users: byDay.get(day)?.active_users ?? 0 };
  });

  const modeRows = (
    await db
      .prepare(
        `SELECT mode, COUNT(*) AS questions, AVG(CASE WHEN error IS NULL THEN latency_ms END) AS avg_latency_ms, AVG(cost_usd) AS avg_cost_usd
         FROM audit_log WHERE ${where} GROUP BY mode`,
      )
      .bind(...params)
      .all<{ mode: "vector" | "agentic"; questions: number; avg_latency_ms: number | null; avg_cost_usd: number | null }>()
  ).results;
  const by_mode: ModeStats[] = (["vector", "agentic"] as const).map((mode) => {
    const r = modeRows.find((x) => x.mode === mode);
    return { mode, questions: r?.questions ?? 0, avg_latency_s: secs(r?.avg_latency_ms ?? null), avg_cost_usd: r?.avg_cost_usd ?? null };
  });

  const assumption = await getAssumption(db);
  const answered = n("answered");
  const nonFailed = n("questions") - n("failed");

  return {
    window: { days, from: from.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10), includes_simulated: includeSimulated, simulated_questions: n("simulated") },
    totals: {
      questions: n("questions"),
      answered,
      answered_with_source: n("answered_with_source"),
      refused: n("refused"),
      failed: n("failed"),
      active_users: n("active_users"),
      answered_with_source_rate: ratio(n("answered_with_source"), nonFailed),
      refusal_rate: ratio(n("refused"), nonFailed),
      thumbs: { up: n("up"), down: n("down"), up_rate: ratio(n("up"), n("up") + n("down")) },
      latency_s: { avg: secs(overall?.avg_latency_ms ?? null), p95: secs(percentile(latencies, 0.95)) },
      cost_usd: { total: n("cost_usd"), per_question: ratio(n("cost_usd"), n("costed")) },
    },
    per_day,
    by_mode,
    time_saved: { minutes_per_search: assumption.minutes_per_search, answered, hours: (answered * assumption.minutes_per_search) / 60, assumption },
    latest_eval: await latestEval(db),
  };
}

/** The newest evaluation run that has results, summarised per mode. */
async function latestEval(db: D1Database): Promise<Dashboard["latest_eval"]> {
  const run = await db
    .prepare("SELECT id, created_at, git_sha, model, judge_model, notes FROM eval_runs r WHERE EXISTS (SELECT 1 FROM eval_results e WHERE e.run_id = r.id) ORDER BY created_at DESC LIMIT 1")
    .first<EvalRunRow>();
  if (!run) return null;
  const rows = (await db.prepare("SELECT * FROM eval_results WHERE run_id = ?").bind(run.id).all<EvalResultRow>()).results;
  return { run, vector: summarize(rows.filter((r) => r.mode === "vector")), agentic: summarize(rows.filter((r) => r.mode === "agentic")) };
}
