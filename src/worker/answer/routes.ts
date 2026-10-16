import { Hono } from "hono";
import { z } from "zod";
import { MAX_QUESTION_CHARS } from "../../config";
import { requireUser } from "../auth/middleware";
import type { AppEnv } from "../env";
import { LimitError, quotaFor } from "../governance/quota";
import { redactText } from "../governance/redact";
import { getDocumentChunks } from "../retrieval/store";
import { defaultServices, type ServicesFactory } from "../services";
import { ipHashOf } from "../util/ip";
import { BadQuestionError, NotConfiguredError, UpstreamError, ask } from "./ask";

const askBody = z.object({ question: z.string().min(1).max(MAX_QUESTION_CHARS), mode: z.enum(["vector", "agentic"]).default("vector") });

// 1 = helpful, -1 = not helpful, 0 = take the rating back.
const feedbackBody = z.object({ auditId: z.string().min(1).max(40), value: z.union([z.literal(1), z.literal(-1), z.literal(0)]) });

export function answerRoutes(services: ServicesFactory = defaultServices) {
  const routes = new Hono<AppEnv>();

  routes.post("/ask", requireUser, async (c) => {
    const parsed = askBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    // The user, and with it the role, comes from the server-side session. Nothing in the body can change it.
    const user = c.get("user")!;
    try {
      const result = await ask(
        { db: c.env.DB, ...services(c.env) },
        { user, question: parsed.data.question, mode: parsed.data.mode, ipHash: await ipHashOf((n) => c.req.header(n)) },
      );
      return c.json(result);
    } catch (e) {
      if (e instanceof LimitError) return c.json({ error: "daily_limit", scope: e.scope, limit: e.limit }, 429);
      if (e instanceof BadQuestionError) return c.json({ error: "invalid_request" }, 400);
      if (e instanceof NotConfiguredError) return c.json({ error: "not_configured" }, 503);
      if (e instanceof UpstreamError) return c.json({ error: "assistant_unavailable", auditId: e.auditId }, 502);
      throw e;
    }
  });

  // A thumbs rating on one's own answer. Only the person who asked can rate it, and only real questions: another user's answer, an eval
  // or simulated row, and an id that does not exist all get the same 404.
  routes.post("/feedback", requireUser, async (c) => {
    const parsed = feedbackBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const { auditId, value } = parsed.data;
    const done = await c.env.DB.prepare("UPDATE audit_log SET feedback = ?, feedback_at = ? WHERE id = ? AND user_id = ? AND source = 'live' AND error IS NULL")
      .bind(value === 0 ? null : value, value === 0 ? null : new Date().toISOString(), auditId, c.get("user")!.id)
      .run();
    if (!done.meta.changes) return c.json({ error: "not_found" }, 404);
    return c.json({ feedback: value === 0 ? null : value });
  });

  routes.get("/quota", requireUser, async (c) => c.json(await quotaFor(c.env.DB, c.get("user")!.id)));

  // The source text a citation points at. Not found and not allowed are the same answer.
  routes.get("/source/:docId", requireUser, async (c) => {
    const user = c.get("user")!;
    const chunks = await getDocumentChunks(c.env.DB, user.role, c.req.param("docId"));
    if (!chunks) return c.json({ error: "not_found" }, 404);
    const first = chunks[0]!;
    return c.json({
      doc: {
        id: first.doc_id,
        title: first.title,
        department: first.department,
        owner_name: first.owner_name,
        owner_role: first.owner_role,
        version: first.version,
        effective_date: first.effective_date,
        is_latest: first.is_latest,
        superseded_by: first.superseded_by,
        language: first.language,
      },
      sections: chunks.map((s) => ({ anchor: s.anchor, section: s.section_path, text: redactText(s.text), injection_flag: s.injection_flag })),
    });
  });

  return routes;
}
