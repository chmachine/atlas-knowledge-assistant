import { Hono } from "hono";
import { z } from "zod";
import { EMBEDDING_MODEL, CLAUDE_MODEL, JUDGE_MODEL } from "../../config";
import { NotConfiguredError, UpstreamError, ask } from "../answer/ask";
import { estimateCost } from "../answer/cost";
import { sourceInfo } from "../answer/prompts";
import type { AppEnv, SessionUser } from "../env";
import { redactText } from "../governance/redact";
import { getChunksByIds, getDocTitles } from "../retrieval/store";
import { judgeAnswer, type Passage } from "../eval/judge";
import { scoreCase } from "../eval/score";
import { evalCaseSchema } from "../eval/schema";
import type { ServicesFactory } from "../services";
import { newId } from "../util/crypto";

// Evaluation endpoints, token only (mounted under /api/ops). The runner script sends one case at a time, so a run can be resumed:
// a (run, case, mode) that already has a result is returned as it is and costs nothing.

const runBody = z.object({ git_sha: z.string().max(40).optional(), notes: z.string().max(300).optional() });
const caseBody = z.object({ runId: z.string().min(1).max(40), case: evalCaseSchema, mode: z.enum(["vector", "agentic"]) });

export function evalRoutes(services: ServicesFactory) {
  const routes = new Hono<AppEnv>();

  routes.post("/run", async (c) => {
    const parsed = runBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const id = newId();
    await c.env.DB.prepare("INSERT INTO eval_runs (id, created_at, git_sha, model, judge_model, embedding_model, notes) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, new Date().toISOString(), parsed.data.git_sha ?? null, CLAUDE_MODEL, JUDGE_MODEL, EMBEDDING_MODEL, parsed.data.notes ?? null)
      .run();
    return c.json({ id });
  });

  routes.post("/case", async (c) => {
    const parsed = caseBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", detail: parsed.error.issues[0]?.message }, 400);
    const { runId, case: ec, mode } = parsed.data;
    const db = c.env.DB;
    if (!(await db.prepare("SELECT 1 AS x FROM eval_runs WHERE id = ?").bind(runId).first())) return c.json({ error: "unknown_run" }, 404);
    const existing = await db.prepare("SELECT * FROM eval_results WHERE run_id = ? AND case_id = ? AND mode = ?").bind(runId, ec.id, mode).first();
    if (existing) return c.json({ ...existing, resumed: true });

    const { judge, ...rest } = services(c.env);
    const user: SessionUser = { id: `eval-${ec.role}`, username: `eval-${ec.role}`, display_name: `Eval ${ec.role}`, role: ec.role, is_admin: false };
    const base = { run_id: runId, case_id: ec.id, mode, role: ec.role, category: ec.category, question: ec.question };
    const store = async (row: Record<string, unknown>) => {
      const cols = Object.keys({ ...base, ...row });
      await db.prepare(`INSERT INTO eval_results (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...Object.values({ ...base, ...row })).run();
      return db.prepare("SELECT * FROM eval_results WHERE run_id = ? AND case_id = ? AND mode = ?").bind(runId, ec.id, mode).first();
    };

    let result;
    try {
      result = await ask({ db, ...rest }, { user, question: ec.question, mode, ipHash: "ops", source: "eval" });
    } catch (e) {
      if (e instanceof NotConfiguredError) return c.json({ error: "not_configured" }, 503);
      if (e instanceof UpstreamError) return c.json(await store({ error: `assistant failed (audit ${e.auditId})` }));
      throw e;
    }

    const audit = await db.prepare("SELECT retrieved_chunk_ids, cited_chunk_ids, cost_usd FROM audit_log WHERE id = ?").bind(result.auditId).first<{ retrieved_chunk_ids: string; cited_chunk_ids: string; cost_usd: number | null }>();
    const retrieved = JSON.parse(audit?.retrieved_chunk_ids ?? "[]") as string[];
    const cited = JSON.parse(audit?.cited_chunk_ids ?? "[]") as string[];
    const labels = new Map((await db.prepare("SELECT id, access_label FROM documents").all<{ id: string; access_label: string }>()).results.map((d) => [d.id, d.access_label]));
    const det = scoreCase(ec, { refused: result.refused, answer: result.answer, retrievedChunkIds: retrieved, citedChunkIds: cited }, (id) => labels.get(id));

    // The judge sees what the assistant saw for each cited passage, in citation order (so [n] in the answer is passage n),
    // with personal data removed like everywhere else. getChunksByIds keeps the order and re-checks the role.
    let passages: Passage[] = [];
    if (cited.length) {
      const chunks = await getChunksByIds(db, ec.role, cited);
      const titles = await getDocTitles(db, ec.role, chunks.flatMap((c) => [c.supersedes, c.superseded_by].filter((id): id is string => !!id)));
      passages = chunks.map((c) => ({ id: c.id, title: c.title, section: c.section_path, info: sourceInfo(c, (id) => titles.get(id)), text: redactText(c.text) }));
    }
    const judged = judge ? await judgeAnswer(judge, ec, result.answer, passages) : null;
    const j = judged?.judgement ?? null;
    return c.json(
      await store({
        retrieval_hit: det.retrieval_hit,
        citation_correct: det.citation_correct,
        refusal_correct: det.refusal_correct,
        leak_free: det.leak_free,
        faithfulness: j?.faithfulness ?? null,
        facts_covered: j ? j.facts_covered.filter(Boolean).length : null,
        facts_total: ec.key_facts.length,
        mentions_older: ec.older ? (j ? (j.mentions_older ? 1 : 0) : null) : null,
        followed_injection: j ? (j.followed_injection ? 1 : 0) : null,
        judge_notes: j?.notes ?? null,
        answer: result.answer,
        refused: result.refused ? 1 : 0,
        refusal_reason: result.refusalReason,
        latency_ms: result.latencyMs,
        answer_cost_usd: audit?.cost_usd ?? null,
        judge_cost_usd: judged ? estimateCost(judged.model || JUDGE_MODEL, judged.usage).costUsd : null,
        audit_id: result.auditId,
        error: judged && !j ? (judged.error ?? "judge failed") : judge ? null : "no judge configured",
      }),
    );
  });

  routes.get("/runs", async (c) => {
    const { results } = await c.env.DB.prepare("SELECT * FROM eval_runs ORDER BY created_at DESC LIMIT 10").all();
    return c.json({ runs: results });
  });

  routes.get("/runs/:id", async (c) => {
    const run = await c.env.DB.prepare("SELECT * FROM eval_runs WHERE id = ?").bind(c.req.param("id")).first();
    if (!run) return c.json({ error: "not_found" }, 404);
    const { results } = await c.env.DB.prepare("SELECT * FROM eval_results WHERE run_id = ? ORDER BY case_id, mode").bind(c.req.param("id")).all();
    return c.json({ run, results });
  });

  return routes;
}
