import { beforeAll, describe, expect, it } from "vitest";
import { loadUsageInputs } from "../scripts/usage-inputs";
import { buildDashboard } from "../src/worker/admin/dashboard";
import { canAccess } from "../src/worker/access/policy";
import { estimateCost } from "../src/worker/answer/cost";
import { recordAudit } from "../src/worker/governance/audit";
import { redactText } from "../src/worker/governance/redact";
import { generateUsage, renderSql, type SimRow, type UsageInputs } from "../src/worker/simulate/usage";
import { makeDb } from "./d1";
import { call, loginAs, makeEnv } from "./helpers";

const NOW = new Date(Date.UTC(2026, 9, 15, 12, 0)); // a Thursday
let inputs: UsageInputs;
let rows: SimRow[];
const docOf = (chunkId: string) => chunkId.split("#")[0]!;
const accessOf = () => new Map(inputs.docs.map((d) => [d.id, d.access]));

beforeAll(() => {
  inputs = loadUsageInputs();
  rows = generateUsage(inputs, { now: NOW });
});

describe("the same seed gives the same history", () => {
  it("rows and SQL are identical on every run, and another seed gives another history", () => {
    const again = generateUsage(inputs, { now: NOW });
    expect(again).toEqual(rows);
    expect(renderSql(again)).toBe(renderSql(rows));
    expect(generateUsage(inputs, { now: NOW, seed: 1 })).not.toEqual(rows);
  });
});

describe("what the rows look like", () => {
  it("are all marked simulated, with unique ordered ids, clearly fictional users and one role per user", () => {
    expect(rows.length).toBeGreaterThan(250);
    expect(rows.every((r) => r.source === "simulated")).toBe(true);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(rows.map((r) => r.id)).toEqual([...rows.map((r) => r.id)].sort());
    expect(rows.every((r) => /^sim-\d\d$/.test(r.user_id) && r.username === r.user_id)).toBe(true);
    const users = new Set(rows.map((r) => r.user_id));
    expect(users.size).toBeGreaterThanOrEqual(30);
    expect(users.size).toBeLessThanOrEqual(40);
    const roles = new Map<string, Set<string>>();
    for (const r of rows) roles.set(r.user_id, (roles.get(r.user_id) ?? new Set()).add(r.role));
    expect([...roles.values()].every((s) => s.size === 1)).toBe(true);
    expect(new Set(rows.map((r) => r.role))).toEqual(new Set(["employee", "it_ops", "hr", "finance"]));
  });

  it("cover exactly the last 14 days up to now, in time order, and nothing after now", () => {
    expect(rows[0]!.created_at >= "2026-10-02T00:00:00.000Z").toBe(true);
    expect(rows.every((r) => r.created_at <= NOW.toISOString())).toBe(true);
    expect(rows.map((r) => r.created_at)).toEqual([...rows.map((r) => r.created_at)].sort());
    const days = new Set(rows.map((r) => r.created_at.slice(0, 10)));
    expect(days.has("2026-10-02")).toBe(true);
    expect(days.has("2026-10-15")).toBe(true);
    const earlier = generateUsage(inputs, { now: new Date(Date.UTC(2026, 9, 15, 7, 0)) });
    expect(earlier.every((r) => r.created_at <= "2026-10-15T07:00:00.000Z")).toBe(true);
  });

  it("follow a working-week rhythm that grows: few questions at weekends, more in the second week than in the first", () => {
    const perDay = new Map<string, number>();
    for (const r of rows) perDay.set(r.created_at.slice(0, 10), (perDay.get(r.created_at.slice(0, 10)) ?? 0) + 1);
    const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
    const weekend = [...perDay].filter(([d]) => [0, 6].includes(dow(d))).map(([, n]) => n);
    const weekday = [...perDay].filter(([d]) => ![0, 6].includes(dow(d))).map(([, n]) => n);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
    expect(mean(weekend)).toBeLessThan(0.2 * mean(weekday));
    const week = (from: string, to: string) => [...perDay].filter(([d]) => d >= from && d <= to).reduce((a, [, n]) => a + n, 0);
    expect(week("2026-10-09", "2026-10-15")).toBeGreaterThan(1.3 * week("2026-10-02", "2026-10-08"));
  });

  it("have plausible shares of refusals, failures, ratings and modes", () => {
    const n = rows.length;
    const refused = rows.filter((r) => r.refused && !r.error).length / n;
    expect(refused).toBeGreaterThan(0.08);
    expect(refused).toBeLessThan(0.22);
    expect(rows.filter((r) => r.error).length / n).toBeLessThan(0.03);
    const rated = rows.filter((r) => r.feedback !== null);
    expect(rated.length).toBeGreaterThan(40);
    const up = rated.filter((r) => r.feedback === 1).length / rated.length;
    expect(up).toBeGreaterThan(0.75);
    expect(up).toBeLessThan(0.97);
    const vector = rows.filter((r) => r.mode === "vector").length / n;
    expect(vector).toBeGreaterThan(0.6);
    expect(vector).toBeLessThan(0.85);
  });
});

describe("permissions hold even in simulated data", () => {
  it("every retrieved and cited passage belongs to a document the asking role may read", () => {
    const access = accessOf();
    for (const r of rows) {
      for (const field of [r.retrieved_chunk_ids, r.cited_chunk_ids]) {
        for (const chunk of JSON.parse(field) as string[]) {
          expect(access.has(docOf(chunk)), `${r.id}: ${chunk} is a real document`).toBe(true);
          expect(canAccess(r.role, access.get(docOf(chunk))!), `${r.id}: ${r.role} may read ${chunk}`).toBe(true);
        }
      }
    }
  });

  it("a question whose expected document the role may not read is never answered from it (it becomes a refusal), even if the question set is wrong", () => {
    const wrong: UsageInputs = { ...inputs, questions: [...inputs.questions.filter((q) => q.role !== "employee"), { role: "employee", question: "Jakie są widełki płacowe w grupie G3?", docs: ["hr-salary-bands"], refuse: false }] };
    const generated = generateUsage(wrong, { now: NOW });
    const employee = generated.filter((r) => r.role === "employee");
    expect(employee.length).toBeGreaterThan(50);
    for (const r of employee) {
      expect(r.refused, r.id).toBe(1);
      expect(r.cited_chunk_ids + r.retrieved_chunk_ids).not.toContain("hr-salary-bands");
      expect((JSON.parse(r.cited_chunk_ids) as string[]).every((c) => docOf(c) === "gen-contacts-directory")).toBe(true);
    }
  });

  it("a role with no questions simply asks nothing", () => {
    const none = generateUsage({ ...inputs, questions: inputs.questions.filter((q) => q.role !== "finance") }, { now: NOW });
    expect(none.some((r) => r.role === "finance")).toBe(false);
    expect(none.length).toBeGreaterThan(100);
  });

  it("an answer always has a source; a refusal cites nothing but the contacts directory; a failure has neither tokens nor cost", () => {
    for (const r of rows) {
      const cited = JSON.parse(r.cited_chunk_ids) as string[];
      if (r.error) {
        expect(r).toMatchObject({ refused: 1, refusal_reason: "error", input_tokens: null, cost_usd: null, answer: "" });
      } else if (r.refused) {
        expect(cited.every((c) => docOf(c) === "gen-contacts-directory"), r.id).toBe(true);
        expect(["no_answer", "uncited"]).toContain(r.refusal_reason);
      } else {
        expect(cited.length, r.id).toBeGreaterThan(0);
        expect(r.refusal_reason).toBeNull();
      }
    }
  });
});

describe("numbers are priced like live answers and sit near the measured averages", () => {
  it("each cost is the real price function applied to the tokens", () => {
    for (const r of rows.filter((x) => x.cost_usd !== null)) {
      expect(r.cost_usd).toBe(estimateCost(r.model, { inputTokens: r.input_tokens!, outputTokens: r.output_tokens!, cacheReadTokens: 0, cacheWriteTokens: 0 }).costUsd);
    }
  });

  it("vector costs about $0.016 and agentic about $0.021 per answer (the eval measured $0.016 and $0.021), agentic more", () => {
    const avg = (mode: string) => {
      const xs = rows.filter((r) => r.mode === mode && r.cost_usd !== null && !r.refused).map((r) => r.cost_usd!);
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    expect(avg("vector")).toBeGreaterThan(0.012);
    expect(avg("vector")).toBeLessThan(0.02);
    expect(avg("agentic")).toBeGreaterThan(0.016);
    expect(avg("agentic")).toBeLessThan(0.028);
    expect(avg("agentic")).toBeGreaterThan(avg("vector"));
  });

  it("latency is a few seconds, within bounds; only agentic rows have search steps", () => {
    expect(rows.every((r) => r.latency_ms >= 1800 && r.latency_ms <= 14000)).toBe(true);
    const mean = rows.reduce((a, r) => a + r.latency_ms, 0) / rows.length;
    expect(mean).toBeGreaterThan(3000);
    expect(mean).toBeLessThan(6000);
    for (const r of rows) {
      const steps = JSON.parse(r.tool_calls) as { tool: string }[];
      if (r.mode === "vector" || r.error) expect(steps).toEqual([]);
      else expect(steps[0]!.tool).toBe("search_text");
    }
  });
});

describe("honesty and hygiene of the text", () => {
  it("questions are the real ones, carry no personal data, and the answer text says it is simulated", () => {
    const pool = new Set(inputs.questions.map((q) => q.question));
    for (const r of rows) {
      expect(pool.has(r.question), r.id).toBe(true);
      expect(redactText(r.question)).toBe(r.question);
      if (!r.error) expect(r.answer.startsWith("[simulated] "), r.id).toBe(true);
    }
  });

  it("injection and personal-data flags appear only where the documents behind the question have them", () => {
    const byQuestion = new Map(inputs.questions.map((q) => [q.question, q]));
    for (const r of rows) {
      const docs = byQuestion.get(r.question)!.docs;
      expect(r.injection_detected === 1, r.id).toBe(docs.includes("gen-it-faq"));
      expect(r.pii_redactions > 0, r.id).toBe(docs.some((d) => ["it-oncall-escalation", "hr-employee-file-template", "fin-supplier-payments"].includes(d)));
    }
    expect(rows.some((r) => r.injection_detected === 1)).toBe(true);
    expect(rows.some((r) => r.pii_redactions > 0)).toBe(true);
  });
});

describe("the SQL", () => {
  const live = (db: ReturnType<typeof makeDb>) => recordAudit(db, { userId: "u_hr", username: "hr", role: "hr", mode: "vector", question: "Prawdziwe pytanie", answer: "Odpowiedź", citedChunkIds: ["hr-leave-policy#a"], createdAt: new Date(Date.UTC(2026, 9, 14, 9)) });
  const evalRow = (db: ReturnType<typeof makeDb>) => recordAudit(db, { userId: "eval-hr", username: "eval-hr", role: "hr", mode: "vector", source: "eval", question: "Pytanie z evala", createdAt: new Date(Date.UTC(2026, 9, 14, 9)) });
  const count = async (db: ReturnType<typeof makeDb>, where = "1=1") => (await db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE ${where}`).first<{ n: number }>())!.n;

  it("loads into the real schema, and running it again replaces the simulated rows and nothing else", async () => {
    const db = makeDb();
    const liveId = await live(db);
    await evalRow(db);
    db.raw.exec(renderSql(rows));
    expect(await count(db, "source = 'simulated'")).toBe(rows.length);
    db.raw.exec(renderSql(rows));
    expect(await count(db, "source = 'simulated'")).toBe(rows.length);
    expect(await count(db, "source = 'live'")).toBe(1);
    expect(await count(db, "source = 'eval'")).toBe(1);
    expect(await db.prepare("SELECT question FROM audit_log WHERE id = ?").bind(liveId).first()).toEqual({ question: "Prawdziwe pytanie" });
    const fewer = generateUsage(inputs, { now: NOW, days: 3 });
    db.raw.exec(renderSql(fewer)); // a different history replaces the earlier one entirely
    expect(await count(db, "source = 'simulated'")).toBe(fewer.length);
  });

  it("stores values exactly, including quotes and SQL-looking text", async () => {
    const db = makeDb();
    const nasty: SimRow = { ...rows[0]!, id: "sim-x", question: "It's a '); DROP TABLE audit_log; -- question", answer: "[simulated] \"quoted\"; semi" };
    db.raw.exec(renderSql([nasty]));
    expect(await db.prepare("SELECT question, answer FROM audit_log WHERE id = 'sim-x'").first()).toEqual({ question: nasty.question, answer: nasty.answer });
    expect(await count(db)).toBe(1);
    expect(() => renderSql([{ ...rows[0]!, latency_ms: Number.NaN }])).toThrow(/non-finite/);
  });

  it("the dashboard counts them as simulated and can leave them out", async () => {
    const db = makeDb();
    await live(db);
    await evalRow(db);
    db.raw.exec(renderSql(rows));
    const all = await buildDashboard(db, { now: NOW });
    expect(all.window.simulated_questions).toBe(rows.length);
    expect(all.totals.questions).toBe(rows.length + 1); // the simulated rows plus the one real question; the eval row is never counted
    expect(all.totals.active_users).toBe(new Set(rows.map((r) => r.user_id)).size + 1);
    expect(all.totals.refused + all.totals.failed).toBe(rows.filter((r) => r.refused).length);
    expect(all.totals.thumbs.up).toBe(rows.filter((r) => r.feedback === 1).length);
    expect(all.totals.answered_with_source).toBe(all.totals.answered); // every simulated answer has a source, like live ones
    const liveOnly = await buildDashboard(db, { now: NOW, includeSimulated: false });
    expect(liveOnly.totals.questions).toBe(1);
    expect(liveOnly.window.simulated_questions).toBe(0);
  });

  it("the admin audit log lists them under the simulated filter only, and the detail says simulated", async () => {
    const db = makeDb();
    db.raw.exec(renderSql(rows));
    const env = makeEnv({ DB: db });
    const cookie = await loginAs(env, "admin");
    const asAdmin = async (qs: string) => (await (await call(env, "GET", `/api/admin/audit${qs}`, { cookie })).json()) as { total: number; rows: { id: string; source: string }[] };
    expect((await asAdmin("")).total).toBe(0); // the default view is real visitors
    const sim = await asAdmin("?source=simulated&limit=5");
    expect(sim.total).toBe(rows.length);
    expect(sim.rows.every((r) => r.source === "simulated")).toBe(true);
    const detail = (await (await call(env, "GET", `/api/admin/audit/${sim.rows[0]!.id}`, { cookie })).json()) as { answer: string };
    expect(detail.answer.startsWith("[simulated]")).toBe(true);
  });
});
