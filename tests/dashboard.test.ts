import { beforeAll, describe, expect, it } from "vitest";
import { buildDashboard, percentile } from "../src/worker/admin/dashboard";
import { recordAudit, type AuditEntry } from "../src/worker/governance/audit";
import { makeDb, type TestDb } from "./d1";
import { call, loginAs, makeEnv } from "./helpers";

// A fixed "now" and a fixed set of rows, so every number the dashboard shows can be worked out by hand.
const NOW = new Date(Date.UTC(2026, 9, 15, 12, 0));
const at = (day: string, hour = 10) => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00.000Z`);
let db: TestDb;

async function row(db: TestDb, e: Partial<AuditEntry> & { createdAt: Date }, feedback?: 1 | -1) {
  const id = await recordAudit(db, { userId: "u1", username: "u1", role: "hr", mode: "vector", question: "Pytanie?", answer: "Odpowiedź", citedChunkIds: ["doc-a#sec"], latencyMs: 3000, costUsd: 0.016, ...e });
  if (feedback) await db.prepare("UPDATE audit_log SET feedback = ? WHERE id = ?").bind(feedback, id).run();
  return id;
}

beforeAll(async () => {
  db = makeDb();
  await row(db, { createdAt: at("2026-10-15", 10), latencyMs: 3000, costUsd: 0.016 }, 1);
  await row(db, { createdAt: at("2026-10-15", 11), latencyMs: 5000, costUsd: 0.02 }, -1);
  await row(db, { createdAt: at("2026-10-14", 9), userId: "u2", username: "u2", role: "employee", mode: "agentic", refused: true, refusalReason: "no_answer", citedChunkIds: ["gen-contacts-directory#x"], latencyMs: 4000, costUsd: 0.018 });
  await row(db, { createdAt: at("2026-10-14", 10), userId: "u2", username: "u2", role: "employee", refused: true, refusalReason: "error", error: "model: boom", citedChunkIds: [], latencyMs: 1000, costUsd: undefined });
  await row(db, { createdAt: at("2026-10-10", 9), userId: "u3", username: "u3", role: "finance", mode: "agentic", latencyMs: 9000, costUsd: 0.03 }, 1);
  await row(db, { createdAt: at("2026-10-10", 10), userId: "u3", username: "u3", role: "finance", citedChunkIds: [], latencyMs: 2000, costUsd: 0.01 }); // answered, but no source: the gap case
  await row(db, { createdAt: at("2026-10-12", 9), userId: "sim1", username: "sim1", source: "simulated", latencyMs: 6000, costUsd: 0.012 });
  await row(db, { createdAt: at("2026-10-12", 10), userId: "sim2", username: "sim2", source: "simulated", refused: true, refusalReason: "no_answer", citedChunkIds: [], latencyMs: 2000, costUsd: 0.01 });
  // Never counted: an eval run, a day before the window, and a day after it.
  await row(db, { createdAt: at("2026-10-15", 9), source: "eval", userId: "eval-hr" });
  await row(db, { createdAt: at("2026-10-01", 23), userId: "u9", username: "u9" });
  await row(db, { createdAt: at("2026-10-16", 0), userId: "u9", username: "u9" });
});

describe("the numbers", () => {
  it("counts each question exactly once as answered, refused or failed, and never counts eval rows or days outside the window", async () => {
    const d = await buildDashboard(db, { now: NOW });
    expect(d.window).toEqual({ days: 14, from: "2026-10-02", to: "2026-10-15", includes_simulated: true, simulated_questions: 2 });
    expect(d.totals).toMatchObject({ questions: 8, failed: 1, refused: 2, answered: 5 });
    expect(d.totals.answered + d.totals.refused + d.totals.failed).toBe(d.totals.questions);
  });

  it("answered with a source counts only answers that carry a citation, and the gap shows", async () => {
    const t = (await buildDashboard(db, { now: NOW })).totals;
    expect(t.answered_with_source).toBe(4); // one answered row has no citation
    expect(t.answered_with_source_rate).toBeCloseTo(4 / 7, 10); // failed rows are not in the denominator
    expect(t.refusal_rate).toBeCloseTo(2 / 7, 10);
  });

  it("active users are distinct people, not questions", async () => {
    expect((await buildDashboard(db, { now: NOW })).totals.active_users).toBe(5); // u1, u2, u3, sim1, sim2
  });

  it("thumbs rate is up / (up + down), and unrated answers do not count", async () => {
    expect((await buildDashboard(db, { now: NOW })).totals.thumbs).toEqual({ up: 2, down: 1, up_rate: 2 / 3 });
  });

  it("latency is averaged over rows that did not fail, with a nearest-rank 95th percentile", async () => {
    const { latency_s } = (await buildDashboard(db, { now: NOW })).totals;
    expect(latency_s.avg).toBeCloseTo(31000 / 7 / 1000, 10); // 3,5,4,9,2,6,2 seconds; the failed row's 1 s is left out
    expect(latency_s.p95).toBe(9);
  });

  it("cost per question divides by the rows that have a cost", async () => {
    const { cost_usd } = (await buildDashboard(db, { now: NOW })).totals;
    expect(cost_usd.total).toBeCloseTo(0.116, 10);
    expect(cost_usd.per_question).toBeCloseTo(0.116 / 7, 10); // the failed row has no cost
  });

  it("splits by mode", async () => {
    const { by_mode } = await buildDashboard(db, { now: NOW });
    expect(by_mode[0]).toMatchObject({ mode: "vector", questions: 6 });
    expect(by_mode[0]!.avg_latency_s).toBeCloseTo(3.6, 10);
    expect(by_mode[0]!.avg_cost_usd).toBeCloseTo(0.0136, 10);
    expect(by_mode[1]).toMatchObject({ mode: "agentic", questions: 2, avg_latency_s: 6.5 });
    expect(by_mode[1]!.avg_cost_usd).toBeCloseTo(0.024, 10);
  });

  it("gives one point per day of the window, in order, with zeros for quiet days", async () => {
    const { per_day } = await buildDashboard(db, { now: NOW });
    expect(per_day).toHaveLength(14);
    expect(per_day[0]!.day).toBe("2026-10-02");
    expect(per_day[13]!.day).toBe("2026-10-15");
    const byDay = Object.fromEntries(per_day.map((p) => [p.day, [p.questions, p.active_users]]));
    expect(byDay).toMatchObject({ "2026-10-15": [2, 1], "2026-10-14": [2, 1], "2026-10-12": [2, 2], "2026-10-10": [2, 1], "2026-10-11": [0, 0], "2026-10-02": [0, 0] });
    expect(per_day.reduce((a, p) => a + p.questions, 0)).toBe(8);
  });

  it("the number of days changes the window", async () => {
    const three = await buildDashboard(db, { now: NOW, days: 3 });
    expect(three.per_day.map((p) => p.day)).toEqual(["2026-10-13", "2026-10-14", "2026-10-15"]);
    expect(three.totals.questions).toBe(4);
    expect((await buildDashboard(db, { now: NOW, days: 500 })).window.days).toBe(60);
    expect((await buildDashboard(db, { now: NOW, days: 0 })).window.days).toBe(1);
  });

  it("the window starts at 00:00:00.000 UTC of its first day and ends before 00:00 of the next day", async () => {
    const edge = makeDb();
    for (const iso of ["2026-10-01T23:59:59.999Z", "2026-10-02T00:00:00.000Z", "2026-10-15T23:59:59.999Z", "2026-10-16T00:00:00.000Z"]) await row(edge, { createdAt: new Date(iso) });
    const d = await buildDashboard(edge, { now: NOW });
    expect(d.totals.questions).toBe(2);
    expect([d.per_day[0]!.questions, d.per_day[13]!.questions]).toEqual([1, 1]);
  });

  it("simulated history can be switched off", async () => {
    const live = await buildDashboard(db, { now: NOW, includeSimulated: false });
    expect(live.window).toMatchObject({ includes_simulated: false, simulated_questions: 0 });
    expect(live.totals).toMatchObject({ questions: 6, failed: 1, refused: 1, answered: 4, answered_with_source: 3, active_users: 3 });
  });
});

describe("time saved is an assumption times answered questions", () => {
  it("uses the default minutes, and refused and failed questions save nothing", async () => {
    const d = await buildDashboard(db, { now: NOW });
    expect(d.time_saved).toMatchObject({ minutes_per_search: 6, answered: 5, hours: 0.5 });
    expect(d.time_saved.assumption).toEqual({ minutes_per_search: 6, updated_by: null, updated_at: null });
  });
});

describe("latest eval", () => {
  it("is null until an eval has results", async () => {
    expect((await buildDashboard(db, { now: NOW })).latest_eval).toBeNull();
  });

  it("is the newest run that has results, summarised per mode; a newer run without results is skipped", async () => {
    const run = (id: string, at: string) => db.prepare("INSERT INTO eval_runs (id, created_at, git_sha, model, judge_model, embedding_model) VALUES (?, ?, 'abc', 'm', 'j', 'e')").bind(id, at).run();
    const result = (runId: string, caseId: string, mode: string, citation: number, faith: number) =>
      db.prepare("INSERT INTO eval_results (run_id, case_id, mode, role, category, question, citation_correct, refusal_correct, faithfulness, answer_cost_usd) VALUES (?, ?, ?, 'hr', 'answerable', 'q', ?, 1, ?, 0.02)").bind(runId, caseId, mode, citation, faith).run();
    await run("old", "2026-10-14T10:00:00.000Z");
    await result("old", "c1", "vector", 0, 1);
    await run("new", "2026-10-15T10:00:00.000Z");
    await result("new", "c1", "vector", 1, 5);
    await result("new", "c2", "vector", 0, 3);
    await result("new", "c1", "agentic", 1, 4);
    await run("empty", "2026-10-15T11:00:00.000Z"); // newest, but nothing ran yet
    const e = (await buildDashboard(db, { now: NOW })).latest_eval!;
    expect(e.run).toMatchObject({ id: "new", git_sha: "abc" });
    expect(e.vector).toMatchObject({ n: 2, citation_correct: { pass: 1, total: 2 }, faithfulness_mean: 4 });
    expect(e.agentic).toMatchObject({ n: 1, citation_correct: { pass: 1, total: 1 }, faithfulness_mean: 4 });
  });
});

describe("nothing yet", () => {
  it("an empty log gives zeros and nulls, never NaN or a division by zero", async () => {
    const d = await buildDashboard(makeDb(), { now: NOW });
    expect(d.totals).toMatchObject({
      questions: 0, answered: 0, refused: 0, failed: 0, active_users: 0, answered_with_source_rate: null, refusal_rate: null,
      thumbs: { up: 0, down: 0, up_rate: null }, latency_s: { avg: null, p95: null }, cost_usd: { total: 0, per_question: null },
    });
    expect(d.time_saved.hours).toBe(0);
    expect(d.per_day).toHaveLength(14);
    expect(d.by_mode.map((m) => m.avg_cost_usd)).toEqual([null, null]);
    expect(JSON.stringify(d)).not.toMatch(/NaN|Infinity/);
    expect(d.latest_eval).toBeNull();
  });

  it("percentile uses the nearest rank", () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
  });
});

describe("HTTP", () => {
  const today = () => new Date();
  const env = () => makeEnv({ DB: db });

  it("is for the Admin only: anonymous 401, every document role 403, the admin 200", async () => {
    const e = env();
    for (const [method, path, body] of [["GET", "/api/admin/dashboard", undefined], ["GET", "/api/admin/settings", undefined], ["PUT", "/api/admin/settings", { minutes_per_search: 8 }]] as const) {
      expect((await call(e, method, path, { body })).status, `${method} ${path} anonymous`).toBe(401);
      for (const role of ["employee", "it_ops", "hr", "finance"]) {
        expect((await call(e, method, path, { body, cookie: await loginAs(e, role) })).status, `${method} ${path} ${role}`).toBe(403);
      }
    }
    expect((await call(e, "GET", "/api/admin/dashboard", { cookie: await loginAs(e, "admin") })).status).toBe(200);
  });

  it("returns aggregates only: no question, answer or document text", async () => {
    const database = makeDb();
    await row(database, { createdAt: today(), question: "Moja tajna sprawa o urlopie", answer: "Tajna odpowiedź" });
    const e = makeEnv({ DB: database });
    const res = await call(e, "GET", "/api/admin/dashboard", { cookie: await loginAs(e, "admin") });
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/tajn|urlop|Odpowiedź/i);
    expect(JSON.parse(text).totals.questions).toBe(1);
  });

  it("validates the query", async () => {
    const e = env();
    const cookie = await loginAs(e, "admin");
    for (const qs of ["?days=0", "?days=61", "?days=x", "?simulated=yes"]) expect((await call(e, "GET", `/api/admin/dashboard${qs}`, { cookie })).status, qs).toBe(400);
    const off = (await (await call(e, "GET", "/api/admin/dashboard?simulated=0&days=7", { cookie })).json()) as { window: { days: number; includes_simulated: boolean } };
    expect(off.window).toMatchObject({ days: 7, includes_simulated: false });
  });

  it("the assumption can be changed within bounds, is attributed, and changes the time saved", async () => {
    const database = makeDb();
    for (let i = 0; i < 3; i++) await row(database, { createdAt: today() });
    await row(database, { createdAt: today(), refused: true, refusalReason: "no_answer" });
    const e = makeEnv({ DB: database });
    const cookie = await loginAs(e, "admin");
    const hours = async () => ((await (await call(e, "GET", "/api/admin/dashboard", { cookie })).json()) as { time_saved: { hours: number; minutes_per_search: number } }).time_saved;
    expect(await hours()).toMatchObject({ hours: 0.3, minutes_per_search: 6 }); // 3 answered x 6 min
    const put = await call(e, "PUT", "/api/admin/settings", { cookie, body: { minutes_per_search: 20 } });
    expect(await put.json()).toMatchObject({ minutes_per_search: 20, updated_by: "admin" });
    expect(await hours()).toMatchObject({ hours: 1, minutes_per_search: 20 });
    expect(await (await call(e, "GET", "/api/admin/settings", { cookie })).json()).toMatchObject({ minutes_per_search: 20, updated_by: "admin" });
    await call(e, "PUT", "/api/admin/settings", { cookie, body: { minutes_per_search: 6 } }); // back to the default value
    expect((await hours()).minutes_per_search).toBe(6);
  });

  it("rejects values outside 1 to 60, fractions, strings and a missing body, and keeps the old value", async () => {
    const e = env();
    const cookie = await loginAs(e, "admin");
    await call(e, "PUT", "/api/admin/settings", { cookie, body: { minutes_per_search: 9 } });
    for (const body of [{ minutes_per_search: 0 }, { minutes_per_search: 61 }, { minutes_per_search: -5 }, { minutes_per_search: 2.5 }, { minutes_per_search: "10" }, {}, null]) {
      expect((await call(e, "PUT", "/api/admin/settings", { cookie, body })).status, JSON.stringify(body)).toBe(400);
    }
    expect(((await (await call(e, "GET", "/api/admin/settings", { cookie })).json()) as { minutes_per_search: number }).minutes_per_search).toBe(9);
  });

  it("a stored value that is out of range (edited by hand) is ignored in favour of the default", async () => {
    const e = env();
    await db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_by, updated_at) VALUES ('minutes_per_search', '100000', 'x', '2026-01-01T00:00:00.000Z')").run();
    const res = await call(e, "GET", "/api/admin/settings", { cookie: await loginAs(e, "admin") });
    expect(await res.json()).toEqual({ minutes_per_search: 6, updated_by: null, updated_at: null });
  });

  it("a change needs the CSRF header", async () => {
    const e = env();
    const cookie = await loginAs(e, "admin");
    const res = await call(e, "PUT", "/api/admin/settings", { cookie, body: { minutes_per_search: 7 }, headers: { "X-KB": "0" } });
    expect(res.status).toBe(403);
  });
});
