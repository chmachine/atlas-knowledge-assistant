import { Hono } from "hono";
import { z } from "zod";
import { requireAdmin } from "../auth/middleware";
import type { AppEnv } from "../env";
import { MAX_DAYS, buildDashboard } from "./dashboard";
import { MAX_MINUTES, MIN_MINUTES, getAssumption, setMinutesPerSearch } from "./settings";

// Admin-only views over the audit log. Everything in it was redacted when it was written (see governance/audit.ts), and the
// admin role reads documents like an employee: it can see what visitors asked and how the assistant answered, nothing more.

const bool = z.enum(["0", "1"]).transform((v) => v === "1");
const query = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  mode: z.enum(["vector", "agentic"]).optional(),
  role: z.enum(["employee", "it_ops", "hr", "finance"]).optional(),
  /** "all" shows live, simulated and eval rows together. The default is real visitors only. */
  source: z.enum(["live", "simulated", "eval", "all"]).default("live"),
  refused: bool.optional(),
  injection: bool.optional(),
  q: z.string().max(100).optional(),
});

const dashboardQuery = z.object({
  days: z.coerce.number().int().min(1).max(MAX_DAYS).default(14),
  simulated: bool.default(true),
});
const settingsBody = z.object({ minutes_per_search: z.number().int().min(MIN_MINUTES).max(MAX_MINUTES) });

const LIST_COLUMNS = `id, created_at, username, role, mode, source, question, refused, refusal_reason, injection_detected, pii_redactions,
  latency_ms, input_tokens, output_tokens, cost_usd, model, fell_back, feedback, error`;

const parseJson = (s: unknown): unknown => {
  try {
    return JSON.parse(String(s ?? "[]"));
  } catch {
    return [];
  }
};

export function adminRoutes() {
  const routes = new Hono<AppEnv>();

  routes.get("/audit", requireAdmin, async (c) => {
    const parsed = query.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const f = parsed.data;

    // Every filter is a bound parameter; the search text has its LIKE wildcards escaped.
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.source !== "all") (where.push("source = ?"), params.push(f.source));
    if (f.mode) (where.push("mode = ?"), params.push(f.mode));
    if (f.role) (where.push("role = ?"), params.push(f.role));
    if (f.refused !== undefined) (where.push("refused = ?"), params.push(f.refused ? 1 : 0));
    if (f.injection !== undefined) (where.push("injection_detected = ?"), params.push(f.injection ? 1 : 0));
    if (f.q?.trim()) (where.push("question LIKE ? ESCAPE '\\'"), params.push(`%${f.q.trim().replace(/[\\%_]/g, "\\$&")}%`));
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`).bind(...params).first<{ n: number }>();
    const { results } = await c.env.DB.prepare(`SELECT ${LIST_COLUMNS} FROM audit_log ${clause} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
      .bind(...params, f.limit, f.offset)
      .all<Record<string, unknown>>();
    return c.json({ total: total?.n ?? 0, limit: f.limit, offset: f.offset, rows: results });
  });

  routes.get("/audit/:id", requireAdmin, async (c) => {
    const row = await c.env.DB.prepare("SELECT * FROM audit_log WHERE id = ?").bind(c.req.param("id")).first<Record<string, unknown>>();
    if (!row) return c.json({ error: "not_found" }, 404);
    const { retrieved_chunk_ids, cited_chunk_ids, tool_calls, ...rest } = row;
    return c.json({ ...rest, retrieved_chunk_ids: parseJson(retrieved_chunk_ids), cited_chunk_ids: parseJson(cited_chunk_ids), tool_calls: parseJson(tool_calls) });
  });

  routes.get("/dashboard", requireAdmin, async (c) => {
    const parsed = dashboardQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    return c.json(await buildDashboard(c.env.DB, { days: parsed.data.days, includeSimulated: parsed.data.simulated }));
  });

  // The one editable assumption. Anyone who can sign in as the Admin demo user can change it, so it is bounded, attributed and visible.
  routes.get("/settings", requireAdmin, async (c) => c.json(await getAssumption(c.env.DB)));
  routes.put("/settings", requireAdmin, async (c) => {
    const parsed = settingsBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", min: MIN_MINUTES, max: MAX_MINUTES }, 400);
    return c.json(await setMinutesPerSearch(c.env.DB, parsed.data.minutes_per_search, c.get("user")!.username));
  });

  return routes;
}
