import { describe, expect, it } from "vitest";
import { anthropicLlm } from "../src/worker/answer/llm";
import { estimateCost } from "../src/worker/answer/cost";
import { parseAnswer } from "../src/worker/answer/citations";
import { AGENTIC_ADDENDUM, SYSTEM_PROMPT, buildSearchResults, sourceInfo, sourceUrl } from "../src/worker/answer/prompts";
import { redactText } from "../src/worker/governance/redact";
import { CLAUDE_MODEL } from "../src/config";
import { recordAudit } from "../src/worker/governance/audit";
import type { ChunkRow } from "../src/worker/retrieval/store";
import { makeDb } from "./d1";

const chunk = (over: Partial<ChunkRow> = {}): ChunkRow => ({
  id: "doc-a#sec", doc_id: "doc-a", title: "Dokument A", section_path: "Sekcja", anchor: "sec", text: "Treść sekcji o urlopie.", access_label: "general", injection_flag: false,
  is_latest: true, superseded_by: null, supersedes: null, owner_name: "Ewa Przykład", owner_role: "Liderka", department: "HR", version: 1, effective_date: "2026-01-01", language: "pl", ...over,
});
const given = [chunk(), chunk({ id: "doc-b#x", doc_id: "doc-b", anchor: "x", title: "Dokument B", section_path: "Inna" })];
const loc = (index: number, c = given[index]!) => ({ type: "search_result_location", search_result_index: index, source: sourceUrl(c), title: c.title, cited_text: "x" });

describe("parseAnswer", () => {
  it("numbers sources by first use, puts markers after the passage, ignores thinking and tool blocks", () => {
    const out = parseAnswer(
      [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: "Pierwsze zdanie.", citations: [loc(1)] },
        { type: "text", text: " Drugie.", citations: [loc(0), loc(1)] },
        { type: "tool_use", id: "t", name: "n", input: {} },
        { type: "text", text: " Bez cytatu." },
      ],
      given,
    );
    expect(out.text).toBe("Pierwsze zdanie. [1] Drugie. [2] [1] Bez cytatu.");
    expect(out.sources.map((s) => [s.n, s.docId])).toEqual([[1, "doc-b"], [2, "doc-a"]]);
    expect(out.noAnswer).toBe(false);
    expect(out.droppedCitations).toBe(0);
  });

  it("repeats of the same source in one block give one marker", () => {
    expect(parseAnswer([{ type: "text", text: "A.", citations: [loc(0), loc(0)] }], given).text).toBe("A. [1]");
  });

  it("recognises the no-answer marker only at the start, removes it, and keeps the sources", () => {
    const yes = parseAnswer([{ type: "text", text: "  [NO_ANSWER] Nie wiem.", citations: [loc(0)] }], given);
    expect(yes).toMatchObject({ noAnswer: true, text: "Nie wiem. [1]" });
    expect(parseAnswer([{ type: "text", text: "Wiem, ale [NO_ANSWER] w środku." }], given).noAnswer).toBe(false);
  });

  it("counts and drops citations that do not match what was given", () => {
    const out = parseAnswer(
      [
        {
          type: "text",
          text: "X.",
          citations: [loc(5, given[0]), { ...loc(0), source: "/source/other#sec" }, { type: "char_location", cited_text: "c" }, { ...loc(0), search_result_index: "0" }],
        },
      ],
      given,
    );
    expect(out.sources).toEqual([]);
    expect(out.droppedCitations).toBe(4);
    expect(out.text).toBe("X.");
  });

  it("takes the snippet from our own database, redacted", () => {
    const c = chunk({ text: "Kontakt: jan@firma.pl. " + "a".repeat(400) });
    const out = parseAnswer([{ type: "text", text: "X.", citations: [loc(0, c)] }], [c]);
    expect(out.sources[0]!.snippet.startsWith("Kontakt: [EMAIL].")).toBe(true);
    expect(out.sources[0]!.snippet.length).toBe(240);
  });

  it("copes with empty content and non-array citations", () => {
    expect(parseAnswer([], given)).toEqual({ text: "", sources: [], noAnswer: false, droppedCitations: 0 });
    expect(parseAnswer([{ type: "text", text: "A", citations: null }], given).text).toBe("A");
  });
});

describe("search_result blocks and source info", () => {
  const titles = (id: string) => ({ "doc-old": "Stary dokument", "doc-new": "Nowy dokument" })[id];

  it("states CURRENT or OUTDATED from trusted fields, with the owner", () => {
    expect(sourceInfo(chunk({ supersedes: "doc-old", version: 2 }), titles)).toBe(
      'SOURCE INFO: document "Dokument A" (id doc-a), section "Sekcja"; owner Ewa Przykład (Liderka), department HR; status CURRENT (version 2, effective 2026-01-01), replaces an older version "Stary dokument"',
    );
    expect(sourceInfo(chunk({ is_latest: false, superseded_by: "doc-new" }), titles)).toContain('status OUTDATED (version 1, effective 2026-01-01), superseded by "Nowy dokument"');
    expect(sourceInfo(chunk({ is_latest: false, superseded_by: "doc-unknown" }), titles)).toContain('superseded by "doc-unknown"');
  });

  it("adds a warning for a flagged passage", () => {
    expect(sourceInfo(chunk({ injection_flag: true }), titles)).toContain("WARNING: this passage contains text addressed to AI assistants");
    expect(sourceInfo(chunk(), titles)).not.toContain("WARNING");
  });

  it("builds citable blocks with a link, a title, the info line and redacted text, and counts the redactions", () => {
    const { blocks, redactions } = buildSearchResults([chunk({ text: "Pisz na jan@firma.pl lub +48 600 100 200." })], titles);
    expect(blocks).toEqual([
      {
        type: "search_result",
        source: "/source/doc-a#sec",
        title: "Dokument A: Sekcja",
        content: [{ type: "text", text: expect.stringMatching(/^SOURCE INFO:/) }, { type: "text", text: "Pisz na [EMAIL] lub [PHONE]." }],
        citations: { enabled: true },
      },
    ]);
    expect(redactions).toEqual({ EMAIL: 1, IBAN: 0, PHONE: 1, PESEL: 0 });
  });
});

describe("cost", () => {
  it("prices tokens at list price", () => {
    expect(estimateCost(CLAUDE_MODEL, { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 })).toEqual({ costUsd: 2 + 10 + 0.2 + 2.5, priceKnown: true });
    expect(estimateCost(CLAUDE_MODEL, { inputTokens: 1500, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 }).costUsd).toBe(0.007);
    expect(estimateCost(CLAUDE_MODEL, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }).costUsd).toBe(0);
  });
  it("prices an unknown (fallback) model like the configured one and says so", () => {
    expect(estimateCost("claude-opus-4-8", { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toEqual({ costUsd: 2, priceKnown: false });
  });
});

describe("the Anthropic adapter", () => {
  function fakeClient(response: Record<string, unknown>) {
    const calls: Record<string, unknown>[] = [];
    const client = { beta: { messages: { create: async (p: Record<string, unknown>) => (calls.push(p), response) } } };
    return { client, calls };
  }
  const base = {
    id: "m", model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "Hej" }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
  };

  it("sends the configured model, the cap, low effort, server-side fallback, and none of the parameters Sonnet 5.5 rejects", async () => {
    const { client, calls } = fakeClient(base);
    await anthropicLlm("key", { client: client as never }).create({ system: "S", messages: [{ role: "user", content: "Q" }], maxTokens: 1234, effort: "low" });
    expect(calls[0]).toEqual({
      model: CLAUDE_MODEL,
      max_tokens: 1234,
      system: "S",
      messages: [{ role: "user", content: "Q" }],
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    for (const forbidden of ["thinking", "temperature", "top_p", "top_k", "tool_choice", "tools"]) expect(calls[0]).not.toHaveProperty(forbidden);
  });

  it("passes tools through when there are some, and leaves tool_choice alone", async () => {
    const { client, calls } = fakeClient(base);
    const tools = [{ name: "list_documents", description: "d", input_schema: { type: "object", properties: {} } }];
    await anthropicLlm("key", { client: client as never }).create({ system: "S", messages: [], tools, maxTokens: 10, effort: "medium" });
    expect(calls[0]).toMatchObject({ tools, output_config: { effort: "medium" } });
    expect(calls[0]).not.toHaveProperty("tool_choice");
  });

  it("maps usage, the answering model and the stop reason, and detects a server-side fallback", async () => {
    const plain = await anthropicLlm("k", { client: fakeClient(base).client as never }).create({ system: "", messages: [], maxTokens: 1, effort: "low" });
    expect(plain).toEqual({ content: base.content, stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 }, model: "claude-sonnet-5-5", fellBack: false });
    const fell = await anthropicLlm("k", {
      client: fakeClient({ ...base, model: "claude-opus-4-8", usage: { ...base.usage, iterations: [{ type: "message" }, { type: "fallback_message" }] } }).client as never,
    }).create({ system: "", messages: [], maxTokens: 1, effort: "low" });
    expect(fell).toMatchObject({ fellBack: true, model: "claude-opus-4-8" });
  });

  it("treats missing cache counters as zero", async () => {
    const { client } = fakeClient({ ...base, usage: { input_tokens: 1, output_tokens: 1 } });
    expect((await anthropicLlm("k", { client: client as never }).create({ system: "", messages: [], maxTokens: 1, effort: "low" })).usage).toEqual({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});

describe("audit log writes", () => {
  it("redacts every text field before it is stored, including tool calls and errors, and stores the arrays as JSON", async () => {
    const db = makeDb();
    const id = await recordAudit(db, {
      userId: "u1", username: "hr", role: "hr", mode: "agentic", question: "Konto PL20 9999 0000 0000 0000 0000 0001?", answer: "Pisz: a@b.pl", citedChunkIds: ["c1"], retrievedChunkIds: ["c1", "c2"],
      toolCalls: [{ name: "search_text", input: { query: "PESEL 12431412345" } }], error: "boom +48 500 000 101", refused: false, injectionDetected: true, costUsd: 0.01, model: "m",
    });
    const row = (await db.prepare("SELECT * FROM audit_log WHERE id = ?").bind(id).first<Record<string, unknown>>())!;
    expect(row).toMatchObject({ question: "Konto [IBAN]?", answer: "Pisz: [EMAIL]", error: "boom [PHONE]", mode: "agentic", source: "live", refused: 0, injection_detected: 1, feedback: null });
    expect(JSON.parse(row.tool_calls as string)).toEqual([{ name: "search_text", input: { query: "PESEL [PESEL]" } }]);
    expect(JSON.parse(row.retrieved_chunk_ids as string)).toEqual(["c1", "c2"]);
    expect(id).toMatch(/^[a-z2-9]{12}$/);
  });

  it("the table refuses values outside its allowed sets", async () => {
    const db = makeDb();
    await expect(db.prepare("INSERT INTO audit_log (id, created_at, role, mode, question) VALUES ('x', 'now', 'hr', 'telepathy', 'q')").run()).rejects.toThrow();
    await expect(db.prepare("INSERT INTO audit_log (id, created_at, role, mode, question, feedback) VALUES ('x', 'now', 'hr', 'vector', 'q', 5)").run()).rejects.toThrow();
  });
});

describe("what the system prompt says about masked personal data", () => {
  // Found by the evaluation: the prompt used to say "It was removed on purpose", and the model repeated that the number "was deliberately
  // removed from the document". What happens is that this assistant masks it before the model sees it.
  const placeholders = redactText("PESEL 12431412345, IBAN PL20 9999 0000 0000 0000 0000 0001, tel. +48 500 000 201, jan.testowy@atlas-logistics.example").match(/\[[A-Z]+\]/g) ?? [];

  it("names every placeholder the redaction really produces", () => {
    expect([...placeholders].sort()).toEqual(["[EMAIL]", "[IBAN]", "[PESEL]", "[PHONE]"]);
    for (const p of placeholders) expect(SYSTEM_PROMPT, p).toContain(p);
  });

  it("says the assistant's privacy filter masked the values, and forbids claiming they are missing from or were removed from the document", () => {
    expect(SYSTEM_PROMPT).toMatch(/privacy filter masked the real values before you saw them/);
    expect(SYSTEM_PROMPT).toMatch(/masked by the assistant's privacy filter and not available through this assistant/);
    expect(SYSTEM_PROMPT).toMatch(/Never say that it is missing from the document or was removed from it/);
  });

  it("no longer tells the model that the data was removed on purpose, in either mode", () => {
    for (const prompt of [SYSTEM_PROMPT, SYSTEM_PROMPT + AGENTIC_ADDENDUM]) expect(prompt).not.toMatch(/removed on purpose|It was removed/);
  });
});
