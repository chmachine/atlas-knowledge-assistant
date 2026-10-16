import { beforeAll, describe, expect, it } from "vitest";
import { recordAudit } from "../src/worker/governance/audit";
import { makeDb, type TestDb } from "./d1";
import { call, loginAs, makeEnv } from "./helpers";

let db: TestDb;
const ids: Record<string, string> = {};

beforeAll(async () => {
  db = makeDb();
  const t = (n: number) => new Date(Date.UTC(2026, 9, 14, 12, n));
  const row = (key: string, over: Parameters<typeof recordAudit>[1]) => recordAudit(db, over).then((id) => (ids[key] = id));
  await row("hrVector", { userId: "u_hr", username: "hr", role: "hr", mode: "vector", question: "Ile dni urlopu?", answer: "4 dni [1]", citedChunkIds: ["hr-leave-policy#urlop-na-zadanie"], retrievedChunkIds: ["a", "b"], latencyMs: 3000, inputTokens: 7000, outputTokens: 200, costUsd: 0.016, model: "claude-sonnet-5-5", createdAt: t(1) });
  await row("empRefused", { userId: "u_employee", username: "employee", role: "employee", mode: "vector", question: "Jakie widełki G3?", answer: "Nie znalazłem.", refused: true, refusalReason: "no_answer", createdAt: t(2) });
  await row("agentic", { userId: "u_it_ops", username: "it_ops", role: "it_ops", mode: "agentic", question: "Jak długie hasło?", answer: "14 znaków", toolCalls: [{ step: 1, tool: "search_text", input: { query: "hasło" }, found: 3 }], injectionDetected: true, createdAt: t(3) });
  await row("simulated", { userId: "sim1", username: "sim1", role: "hr", mode: "vector", source: "simulated", question: "Symulowane pytanie", createdAt: t(4) });
  await row("eval", { userId: "eval-hr", username: "eval-hr", role: "hr", mode: "agentic", source: "eval", question: "Pytanie z evala", createdAt: t(5) });
  await row("pii", { userId: "u_hr", username: "hr", role: "hr", mode: "vector", question: "Mój PESEL 12431412345 i mail jan@firma.pl, 100% pewności_", answer: "Napisz na a@b.pl", createdAt: t(6) });
});

const env = () => makeEnv({ DB: db });
const list = async (cookie: string, qs = "") => {
  const res = await call(env(), "GET", `/api/admin/audit${qs}`, { cookie });
  return { status: res.status, body: (await res.json()) as { total: number; rows: Record<string, unknown>[]; limit: number; offset: number } };
};

describe("access: admin only", () => {
  it("anonymous gets 401; every document role gets 403; the admin gets 200", async () => {
    const e = env();
    expect((await call(e, "GET", "/api/admin/audit")).status).toBe(401);
    expect((await call(e, "GET", `/api/admin/audit/${ids.hrVector}`)).status).toBe(401);
    for (const role of ["employee", "it_ops", "hr", "finance"]) {
      const cookie = await loginAs(e, role);
      expect((await call(e, "GET", "/api/admin/audit", { cookie })).status, role).toBe(403);
      expect((await call(e, "GET", `/api/admin/audit/${ids.hrVector}`, { cookie })).status, role).toBe(403);
    }
    expect((await call(e, "GET", "/api/admin/audit", { cookie: await loginAs(e, "admin") })).status).toBe(200);
  });
});

describe("the list", () => {
  it("shows real visitors by default, newest first, with the fields the admin needs and without the answer text", async () => {
    const cookie = await loginAs(env(), "admin");
    const { body } = await list(cookie);
    expect(body.total).toBe(4);
    expect(body.rows.map((r) => r.id)).toEqual([ids.pii, ids.agentic, ids.empRefused, ids.hrVector]);
    expect(body.rows.every((r) => r.source === "live")).toBe(true);
    const first = body.rows.find((r) => r.id === ids.hrVector)!;
    expect(first).toMatchObject({ username: "hr", role: "hr", mode: "vector", refused: 0, latency_ms: 3000, input_tokens: 7000, output_tokens: 200, cost_usd: 0.016, model: "claude-sonnet-5-5", feedback: null });
    expect(first).not.toHaveProperty("answer");
    expect(first).not.toHaveProperty("tool_calls");
  });

  it("filters by source, mode, role, refusal and injection, and combines them", async () => {
    const cookie = await loginAs(env(), "admin");
    const ids_ = async (qs: string) => (await list(cookie, qs)).body.rows.map((r) => r.id);
    expect(await ids_("?source=simulated")).toEqual([ids.simulated]);
    expect(await ids_("?source=eval")).toEqual([ids.eval]);
    expect((await list(cookie, "?source=all")).body.total).toBe(6);
    expect(await ids_("?mode=agentic")).toEqual([ids.agentic]);
    expect(await ids_("?mode=agentic&source=all")).toEqual([ids.eval, ids.agentic]);
    expect(await ids_("?role=employee")).toEqual([ids.empRefused]);
    expect(await ids_("?refused=1")).toEqual([ids.empRefused]);
    expect((await ids_("?refused=0")).length).toBe(3);
    expect(await ids_("?injection=1")).toEqual([ids.agentic]);
    expect(await ids_("?role=hr&refused=0&mode=vector")).toEqual([ids.pii, ids.hrVector]);
  });

  it("paginates, and reports the total independent of the page", async () => {
    const cookie = await loginAs(env(), "admin");
    const page1 = (await list(cookie, "?source=all&limit=2&offset=0")).body;
    const page3 = (await list(cookie, "?source=all&limit=2&offset=4")).body;
    expect([page1.total, page1.rows.length, page3.rows.length]).toEqual([6, 2, 2]);
    expect((await list(cookie, "?source=all&limit=2&offset=6")).body.rows).toEqual([]);
    expect(new Set([...page1.rows, ...page3.rows].map((r) => r.id)).size).toBe(4);
  });

  it("searches the question text; LIKE wildcards in the search are literal, and hostile text is just text", async () => {
    const cookie = await loginAs(env(), "admin");
    const found = async (q: string) => (await list(cookie, `?source=all&q=${encodeURIComponent(q)}`)).body.rows.map((r) => r.id);
    expect(await found("urlopu")).toEqual([ids.hrVector]);
    expect(await found("%")).toEqual([ids.pii]); // only the question that really contains a percent sign
    expect(await found("_")).toEqual([ids.pii]); // and the one with an underscore
    expect(await found("'; DROP TABLE audit_log; --")).toEqual([]);
    expect(await found("zzz-nothing")).toEqual([]);
    expect((await list(cookie, "?source=all")).body.total).toBe(6); // the table is intact
  });

  it("rejects out-of-range or unknown parameter values with 400", async () => {
    const cookie = await loginAs(env(), "admin");
    for (const qs of ["?limit=0", "?limit=101", "?offset=-1", "?mode=other", "?role=admin", "?source=x", "?refused=yes", "?q=" + "x".repeat(101), "?limit=abc"]) {
      expect((await call(env(), "GET", `/api/admin/audit${qs}`, { cookie })).status, qs).toBe(400);
    }
  });
});

describe("the detail", () => {
  it("returns the full row with the answer and the JSON fields parsed", async () => {
    const cookie = await loginAs(env(), "admin");
    const res = await call(env(), "GET", `/api/admin/audit/${ids.agentic}`, { cookie });
    expect(await res.json()).toMatchObject({
      id: ids.agentic, mode: "agentic", answer: "14 znaków", injection_detected: 1,
      tool_calls: [{ step: 1, tool: "search_text", input: { query: "hasło" }, found: 3 }], retrieved_chunk_ids: [], cited_chunk_ids: [],
    });
    const hr = (await (await call(env(), "GET", `/api/admin/audit/${ids.hrVector}`, { cookie })).json()) as Record<string, unknown>;
    expect(hr).toMatchObject({ retrieved_chunk_ids: ["a", "b"], cited_chunk_ids: ["hr-leave-policy#urlop-na-zadanie"], answer: "4 dni [1]" });
  });

  it("404 for an unknown id, including injection-shaped ones", async () => {
    const cookie = await loginAs(env(), "admin");
    for (const id of ["nope", "' OR 1=1 --", "%"]) expect((await call(env(), "GET", `/api/admin/audit/${encodeURIComponent(id)}`, { cookie })).status).toBe(404);
  });
});

describe("personal data never reaches the admin", () => {
  it("a question and an answer that contained a PESEL and e-mail addresses were stored redacted, and the endpoints return them that way", async () => {
    const cookie = await loginAs(env(), "admin");
    const detail = JSON.stringify(await (await call(env(), "GET", `/api/admin/audit/${ids.pii}`, { cookie })).json());
    const listed = JSON.stringify((await list(cookie)).body);
    for (const text of [detail, listed]) {
      expect(text).not.toMatch(/12431412345|jan@firma|a@b\.pl/);
      expect(text).toContain("[PESEL]");
    }
  });
});
