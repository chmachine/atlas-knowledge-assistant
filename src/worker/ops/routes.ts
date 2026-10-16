import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { MAX_QUESTION_CHARS } from "../../config";
import { ROLES, vectorFilter } from "../access/policy";
import { BadQuestionError, NotConfiguredError, UpstreamError, ask } from "../answer/ask";
import type { AppEnv, SessionUser } from "../env";
import { redactText } from "../governance/redact";
import { getChunksByIds } from "../retrieval/store";
import { evalRoutes } from "./eval-routes";
import { ingestDocument } from "../ingest/indexer";
import { defaultServices, type ServicesFactory } from "../services";
import { sha256Hex, timingSafeEqual } from "../util/crypto";

// Operations endpoints used by scripts (ingestion now, eval later). They are not for browsers: they need the OPS_TOKEN secret.

const encoder = new TextEncoder();

/** Fails closed: without a configured token the endpoints are off, they never open up. */
export const requireOps: MiddlewareHandler<AppEnv> = async (c, next) => {
  const expected = c.env.OPS_TOKEN;
  if (!expected) return c.json({ error: "ops_disabled" }, 503);
  const given = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
  const [a, b] = await Promise.all([sha256Hex(given), sha256Hex(expected)]);
  if (!timingSafeEqual(encoder.encode(a), encoder.encode(b))) return c.json({ error: "unauthorized" }, 401);
  await next();
};

const ingestBody = z.object({
  raw: z.string().min(1).max(200_000),
  force: z.boolean().optional(),
  /** false: index for full-text search only, even if Workers AI and Vectorize are available (local development). */
  vectors: z.boolean().optional(),
});

export function opsRoutes(services: ServicesFactory = defaultServices) {
  const routes = new Hono<AppEnv>();
  routes.use("*", requireOps);

  routes.post("/ingest", async (c) => {
    const parsed = ingestBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const deps = services(c.env);
    const useVectors = parsed.data.vectors !== false;
    if (useVectors && !(deps.embedder && deps.vectors)) {
      return c.json({ error: "vector_search_not_configured", hint: "Workers AI and Vectorize bindings are missing; send vectors:false to index for full-text search only." }, 503);
    }
    try {
      const result = await ingestDocument({ db: c.env.DB, ...(useVectors ? { embedder: deps.embedder, vectors: deps.vectors } : {}) }, parsed.data.raw, { force: parsed.data.force });
      return c.json(result);
    } catch (e) {
      // Bad front matter is the caller's mistake; anything else is ours.
      const message = (e as Error).message;
      const bad = /front matter|expected|Invalid/i.test(message);
      return c.json({ error: bad ? "invalid_document" : "ingest_failed", message: message.slice(0, 300) }, bad ? 400 : 500);
    }
  });

  routes.get("/status", async (c) => {
    const row = await c.env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM documents) AS documents, (SELECT COUNT(*) FROM chunks) AS chunks, (SELECT COUNT(*) FROM documents WHERE embedded = 1) AS embedded",
    ).first<{ documents: number; chunks: number; embedded: number }>();
    return c.json({ ...row, bindings: { ai: Boolean(c.env.AI), vectorize: Boolean(c.env.VECTORIZE) } });
  });

  // --- Diagnostics and evaluation helpers. Token only; no session can reach them. ---------------------------------------------

  const probeBody = z.object({ role: z.enum(ROLES), question: z.string().min(1).max(MAX_QUESTION_CHARS), topK: z.number().int().min(1).max(20).optional() });

  /**
   * Raw vector retrieval for a role, with similarity scores and NO model call. Used to calibrate the similarity threshold.
   * Returns ids, documents, sections and scores only, never passage text. The role filter and the SQL re-check apply exactly as in the app.
   */
  routes.post("/retrieve", async (c) => {
    const parsed = probeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const { embedder, vectors } = services(c.env);
    if (!embedder || !vectors) return c.json({ error: "vector_search_not_configured" }, 503);
    const { role, question, topK } = parsed.data;
    const filter = vectorFilter(role)!;
    const [vector] = await embedder.embed([redactText(question)]);
    if (!vector) return c.json({ error: "embedding_failed" }, 502);
    const matches = await vectors.query(vector, { topK: topK ?? 12, filter });
    const chunks = await getChunksByIds(c.env.DB, role, matches.map((m) => m.id));
    const byId = new Map(chunks.map((ch) => [ch.id, ch]));
    const results = matches.flatMap((m) => {
      const ch = byId.get(m.id);
      return ch ? [{ id: m.id, score: m.score, doc_id: ch.doc_id, section: ch.section_path, access_label: ch.access_label, is_latest: ch.is_latest }] : [];
    });
    // `dropped` counts matches the SQL re-check removed. With a correct vector filter it is always 0.
    return c.json({ results, dropped: matches.length - results.length });
  });

  const askBody = z.object({
    role: z.enum(ROLES),
    question: z.string().min(1).max(MAX_QUESTION_CHARS),
    mode: z.enum(["vector", "agentic"]),
    /** Overrides the similarity threshold for this call (calibration). */
    minSimilarity: z.number().min(0).max(1).optional(),
  });

  /**
   * Runs the full question pipeline as a given role, for evaluation and testing. The audit row is marked source "eval", the run does not
   * use the visitors' daily limits, and the response adds what the audit log recorded (tokens, cost, model).
   */
  routes.post("/ask", async (c) => {
    const parsed = askBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const { role, question, mode, minSimilarity } = parsed.data;
    const user: SessionUser = { id: `eval-${role}`, username: `eval-${role}`, display_name: `Eval ${role}`, role, is_admin: false };
    try {
      const result = await ask({ db: c.env.DB, ...services(c.env), minSimilarity }, { user, question, mode, ipHash: "ops", source: "eval" });
      const audit = await c.env.DB.prepare("SELECT input_tokens, output_tokens, cost_usd, model, fell_back, latency_ms FROM audit_log WHERE id = ?").bind(result.auditId).first();
      return c.json({ ...result, audit });
    } catch (e) {
      if (e instanceof BadQuestionError) return c.json({ error: "invalid_request" }, 400);
      if (e instanceof NotConfiguredError) return c.json({ error: "not_configured" }, 503);
      if (e instanceof UpstreamError) return c.json({ error: "assistant_unavailable", auditId: e.auditId }, 502);
      throw e;
    }
  });

  routes.route("/eval", evalRoutes(services));

  return routes;
}
