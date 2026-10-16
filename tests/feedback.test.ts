import { beforeAll, describe, expect, it } from "vitest";
import { loadCorpus } from "../scripts/check-corpus";
import { createApp } from "../src/worker/index";
import { recordAudit } from "../src/worker/governance/audit";
import { ingestDocument } from "../src/worker/ingest/indexer";
import { makeDb, type TestDb } from "./d1";
import { FakeEmbedder, FakeVectorStore, ScriptedLlm, cite } from "./fakes";
import { call, loginAs, makeEnv } from "./helpers";

let db: TestDb;
const ids: Record<string, string> = {};
const embedder = new FakeEmbedder();
const vectors = new FakeVectorStore();

beforeAll(async () => {
  db = makeDb();
  for (const f of loadCorpus()) await ingestDocument({ db, embedder, vectors }, f.raw);
  const hr = (await db.prepare("SELECT id FROM users WHERE username = 'hr'").first<{ id: string }>())!.id;
  const employee = (await db.prepare("SELECT id FROM users WHERE username = 'employee'").first<{ id: string }>())!.id;
  const base = { role: "hr", mode: "vector", question: "Pytanie?", answer: "Odpowiedź" } as const;
  ids.hrOwn = await recordAudit(db, { ...base, userId: hr, username: "hr" });
  ids.employeeOwn = await recordAudit(db, { ...base, userId: employee, username: "employee", role: "employee" });
  ids.hrEval = await recordAudit(db, { ...base, userId: hr, username: "hr", source: "eval" });
  ids.hrSimulated = await recordAudit(db, { ...base, userId: hr, username: "hr", source: "simulated" });
  ids.hrFailed = await recordAudit(db, { ...base, userId: hr, username: "hr", refused: true, refusalReason: "error", error: "model: boom" });
});

const env = () => makeEnv({ DB: db });
const rate = (cookie: string, auditId: string, value: unknown) => call(env(), "POST", "/api/feedback", { cookie, body: { auditId, value } });
const stored = (id: string) => db.prepare("SELECT feedback, feedback_at FROM audit_log WHERE id = ?").bind(id).first<{ feedback: number | null; feedback_at: string | null }>();

describe("POST /api/feedback", () => {
  it("needs a signed-in user and the CSRF header", async () => {
    expect((await call(env(), "POST", "/api/feedback", { body: { auditId: ids.hrOwn, value: 1 } })).status).toBe(401);
    const cookie = await loginAs(env(), "hr");
    expect((await call(env(), "POST", "/api/feedback", { cookie, body: { auditId: ids.hrOwn, value: 1 }, headers: { "X-KB": "0" } })).status).toBe(403);
    expect(await stored(ids.hrOwn!)).toEqual({ feedback: null, feedback_at: null });
  });

  it("stores thumbs up, changes it to thumbs down, and takes it back", async () => {
    const cookie = await loginAs(env(), "hr");
    const up = await rate(cookie, ids.hrOwn!, 1);
    expect(await up.json()).toEqual({ feedback: 1 });
    const first = await stored(ids.hrOwn!);
    expect(first).toMatchObject({ feedback: 1 });
    expect(first!.feedback_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(await (await rate(cookie, ids.hrOwn!, -1)).json()).toEqual({ feedback: -1 });
    expect(await stored(ids.hrOwn!)).toMatchObject({ feedback: -1 });
    expect(await (await rate(cookie, ids.hrOwn!, 0)).json()).toEqual({ feedback: null });
    expect(await stored(ids.hrOwn!)).toEqual({ feedback: null, feedback_at: null });
  });

  it("a user can only rate their own answers: someone else's, an unknown id, eval, simulated and failed rows all look the same (404) and change nothing", async () => {
    const cookie = await loginAs(env(), "hr");
    for (const id of [ids.employeeOwn!, "does-not-exist", ids.hrEval!, ids.hrSimulated!, ids.hrFailed!, "' OR 1=1 --"]) {
      expect((await rate(cookie, id, 1)).status, id).toBe(404);
    }
    for (const id of [ids.employeeOwn!, ids.hrEval!, ids.hrSimulated!, ids.hrFailed!]) expect(await stored(id), id).toEqual({ feedback: null, feedback_at: null });
  });

  it("rejects anything but 1, -1 or 0, and a missing or oversized id", async () => {
    const cookie = await loginAs(env(), "hr");
    for (const body of [{ auditId: ids.hrOwn, value: 2 }, { auditId: ids.hrOwn, value: "up" }, { auditId: ids.hrOwn, value: null }, { auditId: ids.hrOwn }, { value: 1 }, { auditId: "", value: 1 }, { auditId: "x".repeat(41), value: 1 }, null]) {
      expect((await call(env(), "POST", "/api/feedback", { cookie, body })).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("works on a real answer: ask, then rate the audit id the answer came back with", async () => {
    const llm = new ScriptedLlm((req) => ({ content: [cite(req, (s) => s.startsWith("/source/hr-leave-policy#"), "Do 4 dni.")] }));
    const app = createApp(() => ({ llm, embedder, vectors }));
    const e = env();
    const cookie = await loginAs(e, "hr");
    const answer = (await (await call(e, "POST", "/api/ask", { cookie, app, body: { question: "Ile dni urlopu na żądanie?", mode: "vector" } })).json()) as { auditId: string };
    expect((await call(e, "POST", "/api/feedback", { cookie, app, body: { auditId: answer.auditId, value: 1 } })).status).toBe(200);
    expect(await stored(answer.auditId)).toMatchObject({ feedback: 1 });
    // The admin sees the rating in the audit log.
    const detail = (await (await call(e, "GET", `/api/admin/audit/${answer.auditId}`, { cookie: await loginAs(e, "admin") })).json()) as { feedback: number };
    expect(detail.feedback).toBe(1);
  });
});
