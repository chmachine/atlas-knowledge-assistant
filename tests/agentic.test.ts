import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCorpus } from "../scripts/check-corpus";
import { AGENT_MAX_STEPS, MAX_OUTPUT_TOKENS } from "../src/config";
import type { Role } from "../src/worker/access/policy";
import { ask, NotConfiguredError, UpstreamError, type AskDeps } from "../src/worker/answer/ask";
import type { JsonBlock, LlmRequest, LlmResponse } from "../src/worker/answer/llm";
import { AGENTIC_ADDENDUM, SYSTEM_PROMPT } from "../src/worker/answer/prompts";
import { TOOL_DEFS } from "../src/worker/answer/tools";
import type { SessionUser } from "../src/worker/env";
import { CANARY } from "../src/worker/ingest/corpus-check";
import { ingestDocument } from "../src/worker/ingest/indexer";
import { createApp } from "../src/worker/index";
import { makeDb, type TestDb } from "./d1";
import { ScriptedLlm, cite, firstQuestion, seenResults, toolUse } from "./fakes";
import { call, loginAs, makeEnv } from "./helpers";

let db: TestDb;
beforeAll(async () => {
  db = makeDb();
  for (const f of loadCorpus()) await ingestDocument({ db }, f.raw); // full-text index only: agentic mode needs no vectors
});
beforeEach(async () => {
  await db.prepare("DELETE FROM audit_log").run();
  await db.prepare("DELETE FROM rate_counters").run();
});

type Step = (req: LlmRequest) => Partial<LlmResponse> & { content: JsonBlock[] };
const user = (role: Role): SessionUser => ({ id: `u_${role}`, username: role, display_name: role, role, is_admin: false });
const input = (role: Role, question: string) => ({ user: user(role), question, mode: "agentic" as const, ipHash: "iphash" });
const deps = (llm: ScriptedLlm, extra: Partial<AskDeps> = {}): AskDeps => ({ db, llm, ...extra });

/** A model that plays the given steps in order and repeats the last one. */
const seq = (...steps: Step[]) => {
  let n = 0;
  return new ScriptedLlm((req) => steps[Math.min(n++, steps.length - 1)]!(req));
};
const use = (...calls: [string, string, unknown][]): Step => () => ({ content: calls.map(([id, name, inp]) => toolUse(id, name, inp)), stopReason: "tool_use" });
const final = (match: (s: string) => boolean, text: string): Step => (req) => ({ content: [cite(req, match, text)] });
const from = (docId: string) => (s: string) => s.startsWith(`/source/${docId}#`);
const noAnswer = (text = "[NO_ANSWER] Nie wiem."): Step => () => ({ content: [{ type: "text", text }] });
const toolResults = (req: LlmRequest, messageIndex = 2) => (req.messages[messageIndex]!.content as { type: string; tool_use_id: string; content: unknown; is_error?: boolean }[]);
const rows = async () => (await db.prepare("SELECT * FROM audit_log ORDER BY created_at").all<Record<string, unknown>>()).results;

describe("agentic mode: a cited answer found by the model's own searches", () => {
  it("hr asks about on-demand leave: one search, then a cited answer, with the steps recorded", async () => {
    const llm = seq(use(["t1", "search_text", { query: "urlop na żądanie" }]), final(from("hr-leave-policy"), "Do 4 dni w roku."));
    const res = await ask(deps(llm), input("hr", "Ile dni urlopu na żądanie przysługuje?"));
    expect(res).toMatchObject({ mode: "agentic", refused: false, refusalReason: null, answer: expect.stringMatching(/^Do 4 dni w roku\. \[1\]$/) });
    expect(res.sources[0]).toMatchObject({ docId: "hr-leave-policy", title: "Polityka urlopowa", ownerName: "Agnieszka Wrona" });
    expect(res.steps).toEqual([{ step: 1, tool: "search_text", input: { query: "urlop na żądanie" }, found: expect.any(Number) }]);
    expect(res.steps[0]!.found).toBeGreaterThan(0);
    expect(res.quota).toMatchObject({ used: 1 });

    const [row] = await rows();
    expect(row).toMatchObject({ mode: "agentic", role: "hr", refused: 0, input_tokens: 2400, output_tokens: 600 });
    expect(row!.cost_usd).toBeCloseTo(2 * ((1200 * 2 + 300 * 10) / 1e6), 6);
    expect(JSON.parse(row!.tool_calls as string)).toEqual([expect.objectContaining({ step: 1, tool: "search_text", input: { query: "urlop na żądanie" } })]);
    expect(JSON.parse(row!.cited_chunk_ids as string)).toEqual([res.sources[0]!.chunkId]);
    expect(JSON.parse(row!.retrieved_chunk_ids as string)).toContain(res.sources[0]!.chunkId);
  });

  it("gives the model the tools, the shared rules plus the agentic ones, a medium effort, and only the question to start with", async () => {
    const llm = seq(use(["t1", "search_text", { query: "urlop" }]), final(from("hr-leave-policy"), "Odp."));
    await ask(deps(llm), input("hr", "Ile dni urlopu?"));
    const [first, second] = llm.requests;
    expect(first).toMatchObject({ system: SYSTEM_PROMPT + AGENTIC_ADDENDUM, effort: "medium", maxTokens: MAX_OUTPUT_TOKENS });
    expect(first!.tools).toEqual(TOOL_DEFS);
    expect(first!.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Ile dni urlopu?" }] }]);
    expect(first!.toolChoice).toBeUndefined(); // never forced
    expect(seenResults(first!)).toEqual([]);
    expect(second!.tools).toEqual(TOOL_DEFS);
  });

  it("sends each assistant turn back exactly as it came (thinking blocks included) and all tool results in one user message, in order", async () => {
    const thinking: JsonBlock = { type: "thinking", thinking: "", signature: "sig-1" };
    const step1: Step = () => ({ content: [thinking, toolUse("a", "list_documents", { department: "HR" }), toolUse("b", "search_text", { query: "urlop" })], stopReason: "tool_use" });
    const llm = seq(step1, final(from("hr-leave-policy"), "Odp."));
    await ask(deps(llm), input("hr", "Ile dni urlopu?"));
    const second = llm.requests[1]!;
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]).toEqual({ role: "assistant", content: [thinking, toolUse("a", "list_documents", { department: "HR" }), toolUse("b", "search_text", { query: "urlop" })] });
    const results = toolResults(second);
    expect(results.map((r) => [r.type, r.tool_use_id])).toEqual([["tool_result", "a"], ["tool_result", "b"]]);
    expect(typeof results[0]!.content).toBe("string"); // a document list is plain text
    expect((results[1]!.content as { type: string }[]).every((b) => b.type === "search_result")).toBe(true); // passages are citable blocks
  });

  it("citations still resolve when the cited passage arrives in a later step", async () => {
    const llm = seq(
      use(["t1", "search_text", { query: "praca zdalna dni w tygodniu" }]),
      use(["t2", "read_section", { doc_id: "gen-code-of-conduct", section: "Gifts and hospitality" }]),
      final(from("gen-code-of-conduct"), "The limit is PLN 150."),
    );
    const res = await ask(deps(llm), input("employee", "What is the gift limit?"));
    expect(res.refused).toBe(false);
    expect(res.sources[0]).toMatchObject({ docId: "gen-code-of-conduct", section: "Gifts and hospitality" });
    const seen = seenResults(llm.requests[2]!);
    const idx = seen.findIndex((r) => r.source.startsWith("/source/gen-code-of-conduct#"));
    expect(idx).toBeGreaterThan(0); // after the passages of the first search
    expect(res.steps.map((s) => s.tool)).toEqual(["search_text", "read_section"]);
  });

  it("the same passage returned twice is cited once", async () => {
    const llm = seq(use(["t1", "search_text", { query: "urlop na żądanie" }]), use(["t2", "read_section", { doc_id: "hr-leave-policy", section: "Urlop na żądanie" }]), final(from("hr-leave-policy"), "4 dni."));
    const res = await ask(deps(llm), input("hr", "Ile dni?"));
    expect(res.sources).toHaveLength(1);
    expect(res.answer).toMatch(/\[1\]$/);
  });

  it("counts one question against the daily limit, however many steps it takes", async () => {
    const llm = seq(use(["1", "search_text", { query: "urlop" }]), use(["2", "search_text", { query: "wniosek" }]), use(["3", "search_text", { query: "portal" }]), final(from("hr-leave-policy"), "Odp."));
    await ask(deps(llm), input("hr", "Ile dni urlopu?"));
    expect(llm.requests).toHaveLength(4);
    expect(await db.prepare("SELECT count FROM rate_counters WHERE key LIKE 'ask:user:%'").first()).toEqual({ count: 1 });
  });

  it("works with only the model and the database: no embedder or vector index needed", async () => {
    const llm = seq(use(["t1", "search_text", { query: "urlop" }]), final(from("hr-leave-policy"), "Odp."));
    await expect(ask({ db, llm }, input("hr", "Ile dni urlopu?"))).resolves.toMatchObject({ refused: false });
  });
});

describe("agentic mode: permissions hold for every tool call", () => {
  const generalOnly = (req: LlmRequest) => seenResults(req).every((r) => !/^\/source\/(hr|fin|it|sec)-/.test(r.source));

  it("employee: the HR question gets nothing from HR, and the model can only say it did not find it", async () => {
    const llm = seq(
      use(["a", "search_text", { query: "widełki płacowe grupa G3", role: "hr" }], ["b", "read_section", { doc_id: "hr-salary-bands", section: "Premia roczna", role: "hr", is_admin: true }], ["c", "list_documents", { department: "HR" }]),
      noAnswer("[NO_ANSWER] Nie znalazłem tego w dostępnych dokumentach."),
    );
    const res = await ask(deps(llm), input("employee", "Jakie są widełki płacowe w grupie G3?"));
    expect(res).toMatchObject({ refused: true, refusalReason: "no_answer" });
    const second = llm.requests[1]!;
    expect(generalOnly(second)).toBe(true);
    // what came back from the tools (the question and the model's own queries legitimately mention G3 and the like)
    const returned = JSON.stringify(second.messages[2]);
    for (const secret of ["18% w grupie G5", "8 500", "11 500", "Widełki płacowe i zasady", "hr-salary-bands", "hr-leave-policy"]) expect(returned).not.toContain(secret);
    // the forbidden read is indistinguishable from a read of a document that does not exist
    expect(toolResults(second).find((r) => r.tool_use_id === "b")!.content).toBe("No such document or section is available to you.");
    const listed = String(toolResults(second).find((r) => r.tool_use_id === "c")!.content);
    expect(listed).not.toMatch(/hr-salary|hr-leave|fin-|it-|sec-/);
  });

  it("the owning roles can use the same tools to read their documents", async () => {
    const llm = seq(use(["a", "read_section", { doc_id: "hr-salary-bands", section: "Premia roczna" }]), final(from("hr-salary-bands"), "Premia w G5 to 18%."));
    const res = await ask(deps(llm), input("hr", "Jaka jest premia w G5?"));
    expect(res).toMatchObject({ refused: false });
    expect(res.sources[0]!.docId).toBe("hr-salary-bands");
    expect(JSON.stringify(llm.requests[1])).toContain("18% w grupie G5");
  });

  it("each role sees only its own labels across a mix of searches", async () => {
    const forbidden = { employee: /^\/source\/(hr|fin|it|sec)-/, hr: /^\/source\/(fin|it|sec)-/, finance: /^\/source\/(hr|it|sec)-/, it_ops: /^\/source\/(hr|fin)-/ };
    for (const role of ["employee", "hr", "finance", "it_ops"] as const) {
      const llm = seq(
        use(["a", "search_text", { query: "limit", limit: 8 }], ["b", "search_text", { query: "hasło", limit: 8 }], ["c", "search_text", { query: "premia", limit: 8 }], ["d", "search_text", { query: "awaria", limit: 8 }]),
        noAnswer(),
      );
      await ask(deps(llm), { ...input(role, "Pytanie?"), user: { ...user(role), id: `x-${role}` } });
      for (const r of seenResults(llm.requests[1]!)) expect(r.source, `${role} saw ${r.source}`).not.toMatch(forbidden[role]);
    }
  });
});

describe("agentic mode: personal data and injected instructions", () => {
  it("personal data in what the model types into a tool is redacted before it runs and before it is logged or shown", async () => {
    const llm = seq(use(["a", "search_text", { query: "PESEL 12431412345 urlop jan@firma.pl" }]), final(from("hr-leave-policy"), "Odp."));
    const res = await ask(deps(llm), input("hr", "Ile dni urlopu?"));
    expect(res.steps[0]!.input).toEqual({ query: "PESEL [PESEL] urlop [EMAIL]" });
    const [row] = await rows();
    expect(row!.tool_calls).not.toMatch(/12431412345|jan@firma/);
    expect(row!.tool_calls).toContain("[PESEL]");
  });

  it("a record with personal data comes back from read_section only as placeholders", async () => {
    const llm = seq(use(["a", "read_section", { doc_id: "hr-employee-file-template", section: "Przykładowa karta (dane fikcyjne)" }]), final(from("hr-employee-file-template"), "Karta zawiera imię i stanowisko."));
    await ask(deps(llm), input("hr", "Co jest w kartotece?"));
    const sent = JSON.stringify(llm.requests[1]);
    expect(sent).toContain("[PESEL]");
    expect(sent).not.toMatch(/12431412345|500 000 201|jan\.testowy@|PL20 9999/);
    expect((await rows())[0]!.pii_redactions).toBeGreaterThanOrEqual(4);
  });

  it("the injected passage is flagged when a tool returns it, and a model that obeys it shows nothing", async () => {
    const llm = seq(use(["a", "search_text", { query: "drukarki sieciowe wydruk" }]), () => ({ content: [{ type: "text", text: CANARY }] }));
    const res = await ask(deps(llm), input("employee", "Gdzie są drukarki sieciowe?"));
    expect(res.injectionDetected).toBe(true);
    expect(seenResults(llm.requests[1]!).some((r) => r.info.includes("WARNING: this passage contains text addressed to AI assistants"))).toBe(true);
    expect(res).toMatchObject({ refused: true, refusalReason: "uncited" });
    expect(res.answer).not.toContain(CANARY);
    expect((await rows())[0]).toMatchObject({ injection_detected: 1 });
  });
});

describe("agentic mode: the loop is bounded and tolerant", () => {
  it("bad input, an unknown tool and a repeated call each come back as a message and the loop goes on", async () => {
    const llm = seq(
      use(["a", "search_text", { query: 5 }], ["b", "delete_everything", {}], ["c", "search_text", { query: "urlop" }]),
      use(["d", "search_text", { query: "urlop" }]),
      final(from("hr-leave-policy"), "Odp."),
    );
    const res = await ask(deps(llm), input("hr", "Ile dni urlopu?"));
    expect(res.refused).toBe(false);
    const r2 = toolResults(llm.requests[1]!);
    expect(r2[0]).toMatchObject({ tool_use_id: "a", is_error: true });
    expect(r2[1]).toMatchObject({ tool_use_id: "b", is_error: true });
    expect(r2[2]!.is_error).toBeUndefined();
    const r3 = toolResults(llm.requests[2]!, 4)[0]!;
    expect(r3.content).toMatch(/already made this exact call/);
    // a repeat adds no new passages
    expect(seenResults(llm.requests[2]!)).toHaveLength(seenResults(llm.requests[1]!).length);
    expect(res.steps.filter((s) => s.error).map((s) => s.tool)).toEqual(["search_text", "delete_everything"]);
  });

  it("a tool that throws is reported to the model as an error and logged, and the loop goes on", async () => {
    const broken = new Proxy(db, { get: (t, k, r) => (k === "prepare" ? (sql: string) => { if (sql.includes("chunks_fts")) throw new Error("fts exploded"); return t.prepare(sql); } : Reflect.get(t, k, r)) }) as D1Database;
    const llm = seq(use(["a", "search_text", { query: "urlop" }]), noAnswer());
    const res = await ask({ db: broken, llm }, input("hr", "Ile dni urlopu?"));
    expect(toolResults(llm.requests[1]!)[0]).toMatchObject({ is_error: true, content: "The tool failed. Try a different approach." });
    expect(res.steps[0]!.error).toContain("fts exploded");
    expect(res.refusalReason).toBe("no_answer");
  });

  it("the last allowed step is sent with tool use switched off, and a model that then answers is answered", async () => {
    const queries = ["urlop", "wniosek", "portal", "dni", "pracownik"];
    let n = 0;
    const llm = new ScriptedLlm((req) =>
      req.toolChoice === "none" ? { content: [cite(req, from("hr-leave-policy"), "Odp.")] } : { content: [toolUse(`t${n}`, "search_text", { query: queries[n++] })], stopReason: "tool_use" },
    );
    const res = await ask(deps(llm), input("hr", "Ile dni urlopu?"));
    expect(llm.requests).toHaveLength(AGENT_MAX_STEPS);
    expect(llm.requests.map((r) => r.toolChoice)).toEqual([...Array(AGENT_MAX_STEPS - 1).fill(undefined), "none"]);
    expect(llm.requests.at(-1)!.tools).toEqual(TOOL_DEFS); // still defined: the history contains tool calls
    expect(res.refused).toBe(false);
  });

  it("a model that keeps asking for tools anyway is stopped after exactly the maximum number of model calls", async () => {
    let n = 0;
    const llm = new ScriptedLlm(() => ({ content: [toolUse(`t${n}`, "search_text", { query: `urlop${n++}` })], stopReason: "tool_use" }));
    const res = await ask(deps(llm), input("hr", "Ile dni urlopu?"));
    expect(llm.requests).toHaveLength(AGENT_MAX_STEPS);
    expect(res).toMatchObject({ refused: true, refusalReason: "max_steps", sources: [] });
    expect((await rows())[0]).toMatchObject({ refused: 1, refusal_reason: "max_steps" });
  });

  it("adds up tokens and cost over all model calls, and notes a fallback from any of them", async () => {
    const llm = seq(
      () => ({ content: [toolUse("a", "search_text", { query: "urlop" })], stopReason: "tool_use", usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 0 }, fellBack: true, model: "claude-opus-4-8" }),
      (req) => ({ content: [cite(req, from("hr-leave-policy"), "Odp.")], usage: { inputTokens: 3000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5-5" }),
    );
    await ask(deps(llm), input("hr", "Ile dni urlopu?"));
    expect(await rows()).toEqual([expect.objectContaining({ input_tokens: 4000, output_tokens: 500, cache_read_tokens: 50, fell_back: 1, model: "claude-sonnet-5-5" })]);
  });
});

describe("agentic mode: ways it can end without an answer", () => {
  it("[NO_ANSWER] after fruitless searches, with the contacts directory as the source of who to ask", async () => {
    const llm = seq(
      use(["a", "search_text", { query: "zzzzqqq" }]),
      use(["b", "search_text", { query: "Kontakty działów osoby odpowiedzialne" }]),
      final(from("gen-contacts-directory"), "[NO_ANSWER] Nie znalazłem tego. Zapytaj Agnieszkę Wronę (Dyrektor HR)."),
    );
    const res = await ask(deps(llm), input("employee", "Ile zarabia dyrektor?"));
    expect(res).toMatchObject({ refused: true, refusalReason: "no_answer" });
    expect(res.sources[0]!.docId).toBe("gen-contacts-directory");
    expect(res.steps[0]).toMatchObject({ found: 0 });
    expect(JSON.parse((await rows())[0]!.retrieved_chunk_ids as string)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^gen-contacts-directory#/)])); // not counted as retrieval
  });

  it("an answer with no verified citation is replaced, and a safety refusal is reported as one", async () => {
    const uncited = seq(use(["a", "search_text", { query: "urlop" }]), noAnswer("Z mojej wiedzy: 30 dni."));
    // (noAnswer() here is a plain text block without the marker)
    const res = await ask(deps(uncited), input("hr", "Ile dni urlopu?"));
    expect(res).toMatchObject({ refused: true, refusalReason: "uncited", sources: [] });
    expect(res.answer).not.toContain("30 dni");
    const refusal = seq(() => ({ content: [], stopReason: "refusal" }));
    expect(await ask(deps(refusal), input("hr", "Ile dni urlopu?"))).toMatchObject({ refused: true, refusalReason: "model_refusal" });
  });

  it("a model failure in the middle is audited with what was found so far, and the caller gets only an id", async () => {
    const llm = seq(use(["a", "search_text", { query: "urlop" }]), () => {
      throw new Error("overloaded");
    });
    const err = await ask(deps(llm), input("hr", "Ile dni urlopu?")).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    const [row] = await rows();
    expect(row).toMatchObject({ refused: 1, refusal_reason: "error", id: err.auditId });
    expect(row!.error).toBe("model: overloaded");
    expect(JSON.parse(row!.retrieved_chunk_ids as string).length).toBeGreaterThan(0);
  });
});

describe("POST /api/ask with mode agentic", () => {
  const env = () => makeEnv({ DB: db });
  const body = { question: "Ile dni urlopu na żądanie?", mode: "agentic" };

  it("answers with the steps, using only the model and the database", async () => {
    const llm = seq(use(["a", "search_text", { query: "urlop na żądanie" }]), final(from("hr-leave-policy"), "4 dni."));
    const e = env();
    const res = await call(e, "POST", "/api/ask", { body, cookie: await loginAs(e, "hr"), app: createApp(() => ({ llm })) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "agentic", refused: false, steps: [{ tool: "search_text" }], sources: [{ docId: "hr-leave-policy" }] });
  });

  it("the role comes from the session: an employee cannot become hr by saying so", async () => {
    const llm = seq(use(["a", "read_section", { doc_id: "hr-salary-bands", section: "Premia roczna" }]), noAnswer());
    const e = env();
    await call(e, "POST", "/api/ask", { body: { ...body, role: "hr" }, cookie: await loginAs(e, "employee"), app: createApp(() => ({ llm })) });
    expect(toolResults(llm.requests[1]!)[0]!.content).toBe("No such document or section is available to you.");
    expect((await rows())[0]).toMatchObject({ role: "employee", mode: "agentic" });
  });

  it("vector mode still needs the embedder and the vector index, agentic mode needs the model", async () => {
    const e = env();
    const cookie = await loginAs(e, "hr");
    const onlyLlm = createApp(() => ({ llm: seq(noAnswer()) }));
    expect((await call(e, "POST", "/api/ask", { body: { ...body, mode: "vector" }, cookie, app: onlyLlm })).status).toBe(503);
    expect((await call(e, "POST", "/api/ask", { body, cookie, app: createApp(() => ({})) })).status).toBe(503);
  });

  it("ask() itself refuses to start without a model", async () => {
    await expect(ask({ db }, input("hr", "Pytanie?"))).rejects.toBeInstanceOf(NotConfiguredError);
  });
});

describe("first question text", () => {
  it("is what the model reads first (sanity check of the test helper)", async () => {
    const llm = seq(noAnswer());
    await ask(deps(llm), input("hr", "  Ile dni urlopu?  "));
    expect(firstQuestion(llm.requests[0]!)).toBe("Ile dni urlopu?");
  });
});
