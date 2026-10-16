import { CLAUDE_MODEL } from "../../config";
import { estimateCost } from "../answer/cost";
import { canAccess, type Role } from "../access/policy";

// Two weeks of simulated usage, so the dashboard has something to show before real visitors exist. Everything here is labelled:
// the rows carry source = 'simulated', the users are `sim-NN`, every answer text starts with "[simulated]", and the dashboard
// and the audit log have a switch and a badge for them. Nothing is passed off as real.
//
// What is modelled and what is not: the questions are the real ones from the probe and eval sets, the cited passages are real
// sections of the corpus the asking role may read, and tokens and costs are priced with the same function as live answers, with
// token counts chosen so the averages are close to the ones measured in the eval runs. Who asked when, how long it took and who
// pressed a thumb is invented. A fixed seed makes the output identical every time.

export const SIM_SOURCE = "simulated";
export const DEFAULT_DAYS = 14;
export const DEFAULT_SEED = 20261015;
const CONTACTS_DOC = "gen-contacts-directory";
const PII_DOCS = new Set(["it-oncall-escalation", "hr-employee-file-template", "fin-supplier-payments"]);
/** About one question in eight has no answer the role may see. */
const REFUSAL_SHARE = 0.12;
const INJECTION_DOCS = new Set(["gen-it-faq"]);

export interface SimQuestion {
  role: Role;
  question: string;
  /** Documents the answer is expected to come from. Empty for questions that must be refused. */
  docs: string[];
  refuse: boolean;
}
export interface SimDoc {
  id: string;
  title: string;
  access: string;
  chunks: { id: string; section: string }[];
}
export interface UsageInputs {
  questions: SimQuestion[];
  docs: SimDoc[];
}

/** One audit_log row. The keys are the column names. */
export interface SimRow {
  id: string;
  created_at: string;
  user_id: string;
  username: string;
  role: Role;
  mode: "vector" | "agentic";
  source: typeof SIM_SOURCE;
  question: string;
  retrieved_chunk_ids: string;
  cited_chunk_ids: string;
  tool_calls: string;
  answer: string;
  refused: 0 | 1;
  refusal_reason: string | null;
  injection_detected: 0 | 1;
  pii_redactions: number;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cost_usd: number | null;
  model: string;
  fell_back: 0;
  feedback: 1 | -1 | null;
  feedback_at: string | null;
  error: string | null;
}

// ---- a small seeded random generator, so the same seed always gives the same history ----

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  const normal = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  const weighted = <T>(xs: readonly T[], w: readonly number[]): T => {
    let r = next() * w.reduce((s, v) => s + v, 0);
    for (let i = 0; i < xs.length; i++) {
      r -= w[i]!;
      if (r < 0) return xs[i]!;
    }
    return xs[xs.length - 1]!;
  };
  return { next, int, pick, normal, weighted };
}

/** Fisher-Yates, so the order depends only on the seed and not on how an engine sorts with an inconsistent comparator. */
function shuffle<T>(r: ReturnType<typeof rng>, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// 40 fictional colleagues. Each has one role for the whole period.
const ROSTER: Role[] = [...Array<Role>(22).fill("employee"), ...Array<Role>(6).fill("it_ops"), ...Array<Role>(5).fill("hr"), ...Array<Role>(7).fill("finance")];
const WORK_HOURS_UTC = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]; // 08:00 to 17:59 in Kraków in October
const HOUR_WEIGHTS = [0.5, 1.6, 2.2, 2.0, 1.4, 1.2, 1.7, 1.9, 1.3, 0.5]; // a morning peak and an after-lunch peak

const startOfDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const iso = (ms: number) => new Date(ms).toISOString();
const round = (n: number) => Math.round(n);

/** The first words of the question that carry meaning, the way the agent would search for them. */
const searchQuery = (q: string) => q.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").split(/\s+/).filter((w) => w.length >= 4).slice(0, 4).join(" ");

export function generateUsage(inputs: UsageInputs, opts: { now: Date; days?: number; seed?: number }): SimRow[] {
  const days = Math.max(1, Math.trunc(opts.days ?? DEFAULT_DAYS));
  const r = rng(opts.seed ?? DEFAULT_SEED);
  const docById = new Map(inputs.docs.map((d) => [d.id, d]));
  const lastDay = startOfDay(opts.now);

  // What each role asks about: the real questions, in a random but fixed order of popularity. A share of the questions is
  // one the role has no right to the answer to, or that has no answer in the documents, so the assistant refuses.
  const byRole = new Map<Role, { items: SimQuestion[]; weights: number[]; refuse: SimQuestion[] }>();
  for (const role of new Set(ROSTER)) {
    const own = inputs.questions.filter((q) => q.role === role);
    const items = shuffle(r, own.filter((q) => !q.refuse));
    byRole.set(role, { items, weights: items.map((_, i) => 1 / (i + 1) ** 0.8), refuse: own.filter((q) => q.refuse) });
  }

  const users = ROSTER.map((role, i) => ({ id: `sim-${String(i + 1).padStart(2, "0")}`, role, propensity: 0.5 + r.next() }));
  const rows: Omit<SimRow, "id">[] = [];

  for (let d = 0; d < days; d++) {
    const dayMs = lastDay - (days - 1 - d) * 86_400_000;
    const weekday = new Date(dayMs).getUTCDay();
    const dayFactor = weekday === 0 || weekday === 6 ? 0.08 : 1;
    const ramp = 0.35 + 0.65 * (days > 1 ? d / (days - 1) : 1); // adoption grows over the period
    for (const u of users) {
      if (r.next() >= Math.min(0.95, 0.55 * ramp * dayFactor * u.propensity)) continue;
      const n = 1 + (r.next() < 0.55 ? 1 : 0) + (r.next() < 0.3 ? 1 : 0) + (r.next() < 0.12 ? 1 : 0) + (r.next() < 0.05 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const at = dayMs + r.weighted(WORK_HOURS_UTC, HOUR_WEIGHTS) * 3_600_000 + r.int(0, 59) * 60_000 + r.int(0, 59_999);
        if (at > opts.now.getTime()) continue; // nothing in the future
        const pool = byRole.get(u.role)!;
        const question = pool.refuse.length && (pool.items.length === 0 || r.next() < REFUSAL_SHARE) ? r.pick(pool.refuse) : pool.items.length ? r.weighted(pool.items, pool.weights) : undefined;
        if (question) rows.push(makeRow(r, docById, inputs.docs, u, question, at));
      }
    }
  }
  rows.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.user_id < b.user_id ? -1 : 1));
  return rows.map((row, i) => ({ id: `sim-${String(i + 1).padStart(5, "0")}`, ...row }));
}

function makeRow(r: ReturnType<typeof rng>, docById: Map<string, SimDoc>, allDocs: SimDoc[], u: { id: string; role: Role }, q: SimQuestion, at: number): Omit<SimRow, "id"> {
  const mode: SimRow["mode"] = r.next() < 0.72 ? "vector" : "agentic";
  const readable = allDocs.filter((d) => canAccess(u.role, d.access));
  const chunkIdsOf = (docId: string) => docById.get(docId)?.chunks.map((c) => c.id) ?? [];
  const failed = r.next() < 0.01;
  const docs = q.docs.filter((id) => docById.has(id) && canAccess(u.role, docById.get(id)!.access));
  const refused = failed || q.refuse || docs.length === 0 || r.next() < 0.02;
  const reason = failed ? "error" : refused ? (r.next() < 0.92 ? "no_answer" : "uncited") : null;

  // What the answer cites: real sections of documents this role may read. A refusal may point to the contacts directory.
  const cited: string[] = [];
  if (!refused) {
    const first = r.pick(chunkIdsOf(docs[0]!));
    cited.push(first);
    const extra = docs.length > 1 && r.next() < 0.4 ? r.pick(chunkIdsOf(docs[1]!)) : r.next() < 0.3 ? r.pick(chunkIdsOf(docs[0]!)) : null;
    if (extra && extra !== first) cited.push(extra);
  } else if (!failed && r.next() < 0.7) {
    cited.push(r.pick(chunkIdsOf(CONTACTS_DOC)));
  }
  const retrieved = new Set(cited);
  const sameDoc = docs.length ? chunkIdsOf(docs[0]!) : readable.flatMap((d) => d.chunks.map((c) => c.id));
  for (let i = 0; i < r.int(2, 4); i++) retrieved.add(r.pick(sameDoc));
  const sectionOf = (chunkId: string) => allDocs.flatMap((d) => d.chunks.map((c) => ({ ...c, title: d.title }))).find((c) => c.id === chunkId);

  // Time and tokens, priced like a live answer.
  const latency = Math.min(14_000, Math.max(1_800, round((mode === "vector" ? 3_600 : 4_300) * Math.exp(0.28 * r.normal()))));
  const usage = failed
    ? null
    : {
        inputTokens: mode === "vector" ? r.int(4_500, 7_700) : r.int(6_000, 10_000),
        outputTokens: refused ? r.int(80, 220) : mode === "vector" ? r.int(250, 600) : r.int(300, 700),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };

  const steps =
    mode === "agentic" && !failed
      ? [
          { step: 1, tool: "search_text", input: searchQuery(q.question), found: refused ? r.int(0, 2) : r.int(3, 8) },
          ...(!refused && cited[0] ? [{ step: 2, tool: "read_section", input: { doc_id: cited[0].split("#")[0], section: sectionOf(cited[0])?.section ?? "" }, found: 1 }] : []),
        ]
      : [];

  const rated = !refused && r.next() < 0.35;
  const feedback: 1 | -1 | null = rated ? (r.next() < 0.88 ? 1 : -1) : null;
  const text = failed
    ? ""
    : refused
      ? "[simulated] No supported answer was found in the documents available to this role."
      : `[simulated] Answered from: ${cited.map((c) => `${sectionOf(c)?.title}: ${sectionOf(c)?.section}`).join("; ")}.`;

  return {
    created_at: iso(at),
    user_id: u.id,
    username: u.id,
    role: u.role,
    mode,
    source: SIM_SOURCE,
    question: q.question,
    retrieved_chunk_ids: JSON.stringify([...retrieved]),
    cited_chunk_ids: JSON.stringify(cited),
    tool_calls: JSON.stringify(steps),
    answer: text,
    refused: refused ? 1 : 0,
    refusal_reason: reason,
    injection_detected: q.docs.some((d) => INJECTION_DOCS.has(d)) ? 1 : 0,
    pii_redactions: q.docs.some((d) => PII_DOCS.has(d)) ? r.int(1, 4) : 0,
    latency_ms: latency,
    input_tokens: usage?.inputTokens ?? null,
    output_tokens: usage?.outputTokens ?? null,
    cache_read_tokens: usage ? 0 : null,
    cost_usd: usage ? estimateCost(CLAUDE_MODEL, usage).costUsd : null,
    model: CLAUDE_MODEL,
    fell_back: 0,
    feedback,
    feedback_at: feedback ? iso(at + r.int(1, 30) * 60_000) : null,
    error: failed ? "model: simulated upstream error" : null,
  };
}

// ---- SQL ----

const COLUMNS = [
  "id", "created_at", "user_id", "username", "role", "mode", "source", "question", "retrieved_chunk_ids", "cited_chunk_ids", "tool_calls", "answer", "refused",
  "refusal_reason", "injection_detected", "pii_redactions", "latency_ms", "input_tokens", "output_tokens", "cache_read_tokens", "cost_usd", "model", "fell_back",
  "feedback", "feedback_at", "error",
] as const satisfies readonly (keyof SimRow)[];

const sqlValue = (v: string | number | null): string => {
  if (v === null) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("cannot write a non-finite number");
    return String(v);
  }
  return `'${v.replace(/'/g, "''")}'`;
};

/** A script that replaces all simulated rows. It never touches live or eval rows. */
export function renderSql(rows: SimRow[]): string {
  const lines = [`-- ${rows.length} simulated audit rows (source = 'simulated'). Generated by scripts/seed-usage.ts; running it again replaces them.`, "DELETE FROM audit_log WHERE source = 'simulated';"];
  for (const row of rows) lines.push(`INSERT INTO audit_log (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((c) => sqlValue(row[c])).join(", ")});`);
  return lines.join("\n") + "\n";
}
