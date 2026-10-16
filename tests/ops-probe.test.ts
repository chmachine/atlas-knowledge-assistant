import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCorpus } from "../scripts/check-corpus";
import { createApp } from "../src/worker/index";
import { ingestDocument } from "../src/worker/ingest/indexer";
import { makeDb, type TestDb } from "./d1";
import { FakeEmbedder, FakeVectorStore, LeakyVectorStore, ScriptedLlm, cite, seenResults, toolUse } from "./fakes";
import { call, makeEnv } from "./helpers";

const TOKEN = "ops-token-for-tests-0123456789";
let db: TestDb;
const embedder = new FakeEmbedder();
const vectors = new FakeVectorStore();
const leaky = new LeakyVectorStore();

beforeAll(async () => {
  db = makeDb();
  for (const f of loadCorpus()) await ingestDocument({ db, embedder, vectors }, f.raw);
  leaky.records = vectors.records;
});
beforeEach(async () => {
  await db.prepare("DELETE FROM audit_log").run();
  await db.prepare("DELETE FROM rate_counters").run();
});

const env = () => makeEnv({ DB: db, OPS_TOKEN: TOKEN });
const post = (path: string, body: unknown, app: ReturnType<typeof createApp>, auth: string | null = `Bearer ${TOKEN}`) =>
  call(env(), "POST", path, { body, app, headers: auth ? { authorization: auth } : {} });
const appWith = (llm?: ScriptedLlm, store: FakeVectorStore = vectors) => createApp(() => ({ llm, embedder, vectors: store }));
const rows = async () => (await db.prepare("SELECT * FROM audit_log").all<Record<string, unknown>>()).results;

describe("both endpoints need the ops token", () => {
  for (const path of ["/api/ops/retrieve", "/api/ops/ask"]) {
    it(`${path}: 401 without or with a wrong token, 503 when no token is configured`, async () => {
      const body = { role: "hr", question: "urlop", mode: "vector" };
      expect((await post(path, body, appWith(), null)).status).toBe(401);
      expect((await post(path, body, appWith(), "Bearer nope")).status).toBe(401);
      const unconfigured = await call(makeEnv({ DB: db }), "POST", path, { body, app: appWith(), headers: { authorization: `Bearer ${TOKEN}` } });
      expect(unconfigured.status).toBe(503);
    });
  }
});

describe("POST /api/ops/retrieve", () => {
  it("returns ranked results with scores, documents and sections, and no passage text", async () => {
    const res = await post("/api/ops/retrieve", { role: "hr", question: "Ile dni urlopu na żądanie?", topK: 5 }, appWith());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: Record<string, unknown>[]; dropped: number };
    expect(json.results).toHaveLength(5);
    expect(json.dropped).toBe(0);
    const scores = json.results.map((r) => r.score as number);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(Object.keys(json.results[0]!).sort()).toEqual(["access_label", "doc_id", "id", "is_latest", "score", "section"]);
    expect(JSON.stringify(json)).not.toMatch(/dni urlopu rocznie|Pracownik ma prawo/); // ids and metadata only
  });

  it("applies the role filter: employee never gets a restricted chunk, even from a store that ignores filters", async () => {
    for (const store of [vectors, leaky]) {
      const res = await post("/api/ops/retrieve", { role: "employee", question: "widełki płacowe premia roczna limit hotelu hasło", topK: 20 }, appWith(undefined, store));
      const json = (await res.json()) as { results: { doc_id: string; access_label: string }[]; dropped: number };
      expect(json.results.every((r) => r.access_label === "general")).toBe(true);
      expect(json.results.some((r) => /^(hr|fin|it|sec)-/.test(r.doc_id))).toBe(false);
      if (store === leaky) expect(json.dropped).toBeGreaterThan(0); // the re-check caught what the faulty store returned
    }
  });

  it("redacts the question before it is embedded, and validates the input", async () => {
    embedder.seen = [];
    await post("/api/ops/retrieve", { role: "hr", question: "PESEL 12431412345 urlop" }, appWith());
    expect(embedder.seen).toEqual(["PESEL [PESEL] urlop"]);
    for (const body of [{}, { role: "admin", question: "x" }, { role: "hr", question: "" }, { role: "hr", question: "x", topK: 0 }, { role: "hr", question: "x", topK: 21 }, { role: "hr", question: "x".repeat(1001) }]) {
      expect((await post("/api/ops/retrieve", body, appWith())).status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
  });

  it("says so when vector search is not configured", async () => {
    const res = await post("/api/ops/retrieve", { role: "hr", question: "urlop" }, createApp(() => ({})));
    expect(res.status).toBe(503);
  });
});

describe("POST /api/ops/ask", () => {
  const vectorLlm = () => new ScriptedLlm((req) => ({ content: [cite(req, (s) => s.startsWith("/source/hr-leave-policy#"), "Do 4 dni.")] }));

  it("runs the pipeline as the given role, marks the run as eval, uses no daily limits, and adds tokens and cost", async () => {
    const res = await post("/api/ops/ask", { role: "hr", question: "Ile dni urlopu na żądanie?", mode: "vector", minSimilarity: 0 }, appWith(vectorLlm()));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { refused: boolean; mode: string; sources: { docId: string }[]; audit: Record<string, unknown>; quota: unknown };
    expect(json).toMatchObject({ refused: false, mode: "vector", quota: null, sources: [{ docId: "hr-leave-policy" }], audit: { input_tokens: 1200, output_tokens: 300, model: "claude-sonnet-5-5", fell_back: 0 } });
    expect(json.audit.cost_usd).toBeCloseTo((1200 * 2 + 300 * 10) / 1e6, 6);
    expect(await rows()).toEqual([expect.objectContaining({ source: "eval", user_id: "eval-hr", role: "hr", mode: "vector" })]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM rate_counters WHERE key LIKE 'ask:%'").first()).toEqual({ n: 0 });
  });

  it("enforces the role exactly like the app does: an employee cannot read HR through the agent's tools", async () => {
    let n = 0;
    const llm = new ScriptedLlm((req) =>
      n++ === 0 ? { content: [toolUse("a", "read_section", { doc_id: "hr-salary-bands", section: "Premia roczna" })], stopReason: "tool_use" } : { content: [{ type: "text", text: "[NO_ANSWER] Brak." }] },
    );
    const res = await post("/api/ops/ask", { role: "employee", question: "Jaka jest premia w G5?", mode: "agentic" }, appWith(llm));
    expect(await res.json()).toMatchObject({ refused: true, refusalReason: "no_answer", mode: "agentic" });
    expect(JSON.stringify(llm.requests[1])).toContain("No such document or section is available to you.");
    expect(seenResults(llm.requests[1]!).every((r) => !/^\/source\/hr-/.test(r.source))).toBe(true);
  });

  it("the similarity override changes what the model is given", async () => {
    const run = async (minSimilarity: number) => {
      const llm = new ScriptedLlm(() => ({ content: [{ type: "text", text: "[NO_ANSWER] x" }] }));
      await post("/api/ops/ask", { role: "hr", question: "Ile dni urlopu na żądanie?", mode: "vector", minSimilarity }, appWith(llm));
      return seenResults(llm.requests[0]!).filter((r) => !r.source.startsWith("/source/gen-contacts-directory#")).length;
    };
    expect(await run(0)).toBeGreaterThan(0);
    expect(await run(0.999)).toBe(0); // nothing is that similar; only the contacts directory is attached
  });

  it("reports failures without internals, and rejects bad input", async () => {
    const failing = new ScriptedLlm(() => {
      throw new Error("secret detail");
    });
    const bad = await post("/api/ops/ask", { role: "hr", question: "urlop", mode: "vector", minSimilarity: 0 }, appWith(failing));
    expect(bad.status).toBe(502);
    expect(JSON.stringify(await bad.json())).not.toContain("secret detail");
    for (const body of [{}, { role: "root", question: "x", mode: "vector" }, { role: "hr", question: "x", mode: "other" }, { role: "hr", question: "x", mode: "vector", minSimilarity: 2 }]) {
      expect((await post("/api/ops/ask", body, appWith(vectorLlm()))).status).toBe(400);
    }
    expect((await post("/api/ops/ask", { role: "hr", question: "x", mode: "vector" }, createApp(() => ({})))).status).toBe(503);
  });
});
