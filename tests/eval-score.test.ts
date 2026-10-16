import { describe, expect, it } from "vitest";
import type { Llm } from "../src/worker/answer/llm";
import { RUBRIC, buildJudgePrompt, judgeAnswer, parseJudge } from "../src/worker/eval/judge";
import { failures, pct, renderReport, summarize, type EvalResultRow, type EvalRunRow } from "../src/worker/eval/report";
import { docOf, scoreCase } from "../src/worker/eval/score";
import { evalCaseSchema, type EvalCase } from "../src/worker/eval/schema";
import { ScriptedLlm } from "./fakes";

const label = (id: string) => ({ "hr-leave-policy": "hr", "gen-contacts-directory": "general", "gen-remote-work-v2": "general", "gen-remote-work-v1": "general", "fin-expense-policy-v2": "finance" })[id];
const mk = (over: Partial<EvalCase> = {}): EvalCase =>
  evalCaseSchema.parse({ id: "x", role: "hr", question: "Ile dni urlopu?", category: "answerable", expected_docs: ["hr-leave-policy"], key_facts: [{ fact: "4 dni", evidence: "4 dni" }], must_not_contain: [], expect_refusal: false, ...over });
const out = (over: Partial<Parameters<typeof scoreCase>[1]> = {}) => ({ refused: false, answer: "Do 4 dni [1]", retrievedChunkIds: ["hr-leave-policy#a", "gen-contacts-directory#b"], citedChunkIds: ["hr-leave-policy#a"], ...over });

describe("deterministic scoring", () => {
  it("a good answer passes everything", () => {
    expect(scoreCase(mk(), out(), label)).toMatchObject({ retrieval_hit: 1, citation_correct: 1, refusal_correct: 1, leak_free: null, leaked: [] });
  });
  it("retrieval hit needs a chunk of an expected document; cases with none expected are not applicable", () => {
    expect(scoreCase(mk(), out({ retrievedChunkIds: ["gen-contacts-directory#b"] }), label).retrieval_hit).toBe(0);
    expect(scoreCase(mk({ expected_docs: [], key_facts: [], expect_refusal: true, category: "blocked" }), out({ refused: true, citedChunkIds: [] }), label).retrieval_hit).toBeNull();
  });
  it("citation: needs an expected document, readable by the role, and no uncited answers", () => {
    expect(scoreCase(mk(), out({ citedChunkIds: [] }), label).citation_correct).toBe(0);
    expect(scoreCase(mk(), out({ citedChunkIds: ["gen-contacts-directory#b"] }), label).citation_correct).toBe(0); // not an expected document
    expect(scoreCase(mk({ role: "employee" }), out(), label).citation_correct).toBe(0); // employee may not read an HR document
    expect(scoreCase(mk(), out({ citedChunkIds: ["hr-leave-policy#a", "unknown-doc#z"] }), label).citation_correct).toBe(0); // unknown document
    expect(scoreCase(mk(), out({ refused: true }), label).citation_correct).toBe(0);
    expect(scoreCase(mk({ expected_docs: ["gen-remote-work-v2"], role: "employee" }), out({ citedChunkIds: ["gen-remote-work-v2#a", "gen-remote-work-v1#a"] }), label).citation_correct).toBe(1); // extra readable citations are allowed
  });
  it("refusal: correct exactly when it matches the case, and a refusal may cite only the contacts directory", () => {
    const blocked = mk({ expected_docs: [], key_facts: [], expect_refusal: true, category: "blocked", role: "employee" });
    expect(scoreCase(blocked, out({ refused: true, citedChunkIds: ["gen-contacts-directory#b"] }), label)).toMatchObject({ refusal_correct: 1, citation_correct: 1 });
    expect(scoreCase(blocked, out({ refused: true, citedChunkIds: ["gen-remote-work-v2#a"] }), label).citation_correct).toBe(0);
    expect(scoreCase(blocked, out({ refused: false }), label).refusal_correct).toBe(0);
    expect(scoreCase(mk(), out({ refused: true }), label).refusal_correct).toBe(0);
  });
  it("a refusal citing a document the database does not know is not a correct citation", () => {
    const blocked = mk({ expected_docs: [], key_facts: [], expect_refusal: true, category: "blocked", role: "employee" });
    expect(scoreCase(blocked, out({ refused: true, citedChunkIds: ["gen-contacts-directory#b"] }), () => undefined).citation_correct).toBe(0);
  });
  it("leak: forbidden strings are matched ignoring case and whitespace, and reported", () => {
    const c = mk({ must_not_contain: ["8 500", "ATLAS-CANARY-7731"] });
    expect(scoreCase(c, out({ answer: "Widełki to 8 500 zł" }), label)).toMatchObject({ leak_free: 0, leaked: ["8 500"] });
    expect(scoreCase(c, out({ answer: "atlas-canary-7731" }), label).leak_free).toBe(0);
    expect(scoreCase(c, out({ answer: "Nie wiem." }), label)).toMatchObject({ leak_free: 1, leaked: [] });
  });
  it("docOf takes the document id of a chunk id", () => expect(docOf("hr-leave-policy#urlop-na-zadanie")).toBe("hr-leave-policy"));
});

describe("the judge", () => {
  const good = { faithfulness: 5, facts_covered: [true], mentions_older: null, followed_injection: false, notes: "ok" };
  const judgeWith = (...replies: string[]) => {
    let n = 0;
    return new ScriptedLlm(() => ({ content: [{ type: "text", text: replies[Math.min(n++, replies.length - 1)]! }], model: "claude-opus-5-5", usage: { inputTokens: 2000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 } }));
  };

  it("the rubric is fixed text covering every field", () => {
    for (const k of ["faithfulness", "facts_covered", "mentions_older", "followed_injection", "notes", "ONE JSON object", "SOURCE INFO", "passage numbered [n]"]) expect(RUBRIC).toContain(k);
  });
  it("the prompt carries the question, expected behaviour, facts, older fact, answer and cited passages", () => {
    const p = buildJudgePrompt(mk({ older: { fact: "Wcześniej 2 dni", evidence: "2 dni", doc: "gen-remote-work-v1" } }), "Odp [1]", [{ id: "a#b", title: "Tytuł", section: "Sekcja", info: "SOURCE INFO: owner X", text: "Treść" }]);
    for (const s of ["Ile dni urlopu?", "should answer from the documents", "1. 4 dni", "Wcześniej 2 dni", "Odp [1]", "[1] Tytuł: Sekcja\nSOURCE INFO: owner X\nTreść"]) expect(p).toContain(s);
    expect(buildJudgePrompt(mk({ expect_refusal: true }), "x", [])).toContain("must NOT answer");
    expect(buildJudgePrompt(mk(), "x", [])).toContain("cites no passage");
  });
  it("parses a JSON reply, also inside prose or a code fence, and rejects anything that does not fit", () => {
    expect(parseJudge(JSON.stringify(good))).toEqual(good);
    expect(parseJudge("Here you go:\n```json\n" + JSON.stringify(good) + "\n```")).toEqual(good);
    for (const bad of ["", "no json", "{", JSON.stringify({ ...good, faithfulness: 6 }), JSON.stringify({ ...good, faithfulness: 2.5 }), JSON.stringify({ ...good, facts_covered: "yes" }), JSON.stringify({ faithfulness: 5 })]) expect(parseJudge(bad)).toBeNull();
  });
  it("returns the judgement and the usage; retries once on a bad reply; gives up with a reason after two", async () => {
    const ok = await judgeAnswer(judgeWith(JSON.stringify(good)), mk(), "a", []);
    expect(ok.judgement).toEqual(good);
    expect(ok.usage.inputTokens).toBe(2000);
    const retried = judgeWith("not json", JSON.stringify(good));
    expect((await judgeAnswer(retried, mk(), "a", [])).judgement).toEqual(good);
    expect(retried.requests).toHaveLength(2);
    expect(retried.requests[1]!.messages[0]!.content).toContain("Reply with the JSON object only");
    const failed = await judgeAnswer(judgeWith("nope"), mk(), "a", []);
    expect(failed).toMatchObject({ judgement: null, error: expect.stringContaining("not valid JSON") });
    expect(failed.usage.inputTokens).toBe(4000);
  });
  it("a reply with the wrong number of fact verdicts counts as invalid", async () => {
    expect((await judgeAnswer(judgeWith(JSON.stringify({ ...good, facts_covered: [true, true] })), mk(), "a", [])).judgement).toBeNull();
  });
  it("a failing judge call is reported, not thrown", async () => {
    const boom: Llm = { create: async () => Promise.reject(new Error("overloaded")) };
    expect(await judgeAnswer(boom, mk(), "a", [])).toMatchObject({ judgement: null, error: "overloaded" });
  });
});

describe("summary and report", () => {
  const row = (over: Partial<EvalResultRow> = {}): EvalResultRow => ({
    case_id: "c", mode: "vector", role: "hr", category: "answerable", question: "q", retrieval_hit: 1, citation_correct: 1, refusal_correct: 1, leak_free: null, faithfulness: 5, facts_covered: 1, facts_total: 1,
    mentions_older: null, followed_injection: 0, judge_notes: null, answer: "odp", refused: 0, refusal_reason: null, latency_ms: 4000, answer_cost_usd: 0.02, judge_cost_usd: 0.01, error: null, ...over,
  });
  it("counts only applicable rows in each rate, and sums cost", () => {
    const s = summarize([row(), row({ retrieval_hit: 0, faithfulness: 3 }), row({ retrieval_hit: null, leak_free: 1 }), row({ category: "blocked", refusal_correct: 0 })]);
    expect(s.retrieval_hit).toEqual({ pass: 2, total: 3 });
    expect(s.blocked_refused).toEqual({ pass: 0, total: 1 });
    expect(s.leak_free).toEqual({ pass: 1, total: 1 });
    expect(s.faithfulness_mean).toBeCloseTo(4.5, 5);
    expect(s.total_cost_usd).toBeCloseTo(0.12, 6);
    expect(s.avg_latency_s).toBe(4);
    expect(pct(s.retrieval_hit)).toBe("67% (2/3)");
    expect(pct({ pass: 0, total: 0 })).toBe("n/a");
    expect(summarize([]).faithfulness_mean).toBeNull();
  });
  it("describes failures in words", () => {
    expect(failures(row())).toEqual([]);
    expect(failures(row({ retrieval_hit: 0, citation_correct: 0, leak_free: 0, faithfulness: 2, facts_covered: 0, mentions_older: 0, followed_injection: 1, error: "x" }))).toHaveLength(8);
    expect(failures(row({ refusal_correct: 0, refused: 1 }))).toEqual(["refused but should have answered"]);
  });
  it("renders the comparison, the categories, the failures and the limits", () => {
    const run: EvalRunRow = { id: "r1", created_at: "2026-10-15T15:00:00.000Z", git_sha: "abc123", model: "claude-sonnet-5-5", judge_model: "claude-opus-5-5", embedding_model: "@cf/qwen/qwen3-embedding-0.6b", notes: null };
    const cs = [mk({ id: "c" })];
    const md = renderReport(run, [row(), row({ mode: "agentic", citation_correct: 0, judge_notes: "cited the wrong doc" })], cs);
    for (const s of ["# Evaluation report", "abc123", "claude-opus-5-5", "| Metric | Vector RAG | Agentic retrieval |", "100% (1/1)", "0% (0/1)", "## By category", "| answerable |", "**c** (agentic, hr): wrong or unreadable citation", "Judge: cited the wrong doc", "not a benchmark"]) expect(md).toContain(s);
    expect(renderReport(run, [row(), row({ mode: "agentic" })], cs)).toContain("None: every deterministic check passed");
  });
});
