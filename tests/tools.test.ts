import { beforeAll, describe, expect, it } from "vitest";
import { loadCorpus } from "../scripts/check-corpus";
import { ROLES } from "../src/worker/access/policy";
import { TOOL_DEFS, runTool, type ToolContext } from "../src/worker/answer/tools";
import { ingestDocument } from "../src/worker/ingest/indexer";
import { makeDb, type TestDb } from "./d1";

// MANDATORY: the agent's tools enforce the caller's role. The role is part of the context the server builds, never of the model's input.

let db: TestDb;
beforeAll(async () => {
  db = makeDb();
  for (const f of loadCorpus()) await ingestDocument({ db }, f.raw);
});
const ctx = (role: string): ToolContext => ({ db, role });
const asText = (c: unknown) => (typeof c === "string" ? c : JSON.stringify(c));
const RESTRICTED = /^(hr|fin|it|sec)-/;

function counting(real: D1Database) {
  let n = 0;
  return { db: new Proxy(real, { get: (t, k, r) => (k === "prepare" ? (sql: string) => (n++, t.prepare(sql)) : Reflect.get(t, k, r)) }) as D1Database, count: () => n };
}

describe("tool definitions", () => {
  it("offer exactly three tools, and none of them takes a role, user or permission parameter", () => {
    expect(TOOL_DEFS.map((t) => t.name)).toEqual(["list_documents", "search_text", "read_section"]);
    for (const t of TOOL_DEFS) {
      const props = Object.keys((t.input_schema as { properties: Record<string, unknown> }).properties);
      expect(props.some((p) => /role|user|admin|label|access|permission/i.test(p)), `${t.name}: ${props}`).toBe(false);
      expect((t.input_schema as { additionalProperties: boolean }).additionalProperties).toBe(false);
    }
  });
});

describe("a role with no access", () => {
  it("gets nothing from any tool and no SQL is run", async () => {
    for (const role of ["", "admin", "superuser", "__proto__"]) {
      const { db: counted, count } = counting(db);
      const c = { db: counted, role };
      expect((await runTool(c, "list_documents", {})).found).toBe(0);
      expect((await runTool(c, "search_text", { query: "urlop" })).found).toBe(0);
      expect(asText((await runTool(c, "read_section", { doc_id: "gen-bhp-safety", section: "Szkolenia" })).content)).toBe("No such document or section is available to you.");
      expect(count(), role).toBe(0);
    }
  });
});

describe("list_documents", () => {
  it("lists exactly the documents of the role, and a department filter or extra fields never widen it", async () => {
    const counts: Record<string, number> = {};
    for (const role of ROLES) {
      const out = await runTool(ctx(role), "list_documents", {});
      counts[role] = out.found;
      expect(out.chunks).toEqual([]);
    }
    expect(counts).toEqual({ employee: 11, it_ops: 23, hr: 18, finance: 17 });

    const asEmployee = await runTool(ctx("employee"), "list_documents", { department: "HR", role: "hr", access: "hr", is_admin: true });
    const ids = asText(asEmployee.content).split("\n").map((l) => (JSON.parse(l) as { id: string }).id);
    expect(ids.sort()).toEqual(["gen-onboarding-guide", "gen-remote-work-v1", "gen-remote-work-v2"]);
    expect((await runTool(ctx("employee"), "list_documents", { department: "Finanse" })).found).toBe(0);
  });

  it("states the owner and whether each version is current", async () => {
    const lines = asText((await runTool(ctx("employee"), "list_documents", {})).content).split("\n").map((l) => JSON.parse(l) as Record<string, string>);
    expect(lines.find((l) => l.id === "gen-remote-work-v1")).toMatchObject({ status: "OUTDATED (superseded by gen-remote-work-v2)", version: 1 });
    expect(lines.find((l) => l.id === "gen-remote-work-v2")).toMatchObject({ status: "CURRENT", owner: "Agnieszka Wrona, Dyrektor HR" });
  });
});

describe("search_text", () => {
  it("returns citable search_result blocks with a source link and a status line", async () => {
    const out = await runTool(ctx("hr"), "search_text", { query: "urlop na żądanie" });
    expect(out.found).toBeGreaterThan(0);
    const blocks = out.content as { type: string; source: string; citations: { enabled: boolean }; content: { text: string }[] }[];
    expect(blocks.every((b) => b.type === "search_result" && b.citations.enabled && /^\/source\/[a-z0-9-]+#[a-z0-9-]+$/.test(b.source))).toBe(true);
    expect(blocks[0]!.content[0]!.text).toMatch(/^SOURCE INFO: document ".+" \(id [a-z0-9-]+\)/);
    expect(out.chunks).toHaveLength(blocks.length);
  });

  it("never returns a restricted passage to a role that may not read it, whatever the model asks for", async () => {
    const queries = ["widełki płacowe grupa G3", "premia roczna", "limit noclegu delegacja", "hasło 14 znaków", "failover węzeł zapasowy", "PESEL kartoteka"];
    for (const role of ["employee", "hr", "finance", "it_ops"] as const) {
      for (const q of queries) {
        const out = await runTool(ctx(role), "search_text", { query: q, limit: 8, role: "hr", is_admin: true, access_label: "hr" });
        for (const c of out.chunks) {
          const forbidden = { employee: RESTRICTED, hr: /^(fin|it|sec)-/, finance: /^(hr|it|sec)-/, it_ops: /^(hr|fin)-/ }[role];
          expect(c.doc_id, `${role} got ${c.doc_id} for "${q}"`).not.toMatch(forbidden);
        }
      }
    }
  });

  it("respects the limit, defaults to five, and says so when nothing matches", async () => {
    expect((await runTool(ctx("it_ops"), "search_text", { query: "incydent", limit: 2 })).found).toBeLessThanOrEqual(2);
    expect((await runTool(ctx("it_ops"), "search_text", { query: "incydent" })).found).toBeLessThanOrEqual(5);
    const none = await runTool(ctx("employee"), "search_text", { query: "zzzzzzqqq" });
    expect(none).toMatchObject({ found: 0, isError: false });
    expect(asText(none.content)).toMatch(/No passages matched/);
  });

  it("hands over personal data only as placeholders", async () => {
    const out = await runTool(ctx("hr"), "search_text", { query: "kartoteka PESEL fikcyjne", limit: 8 });
    const sent = asText(out.content);
    expect(sent).toContain("[PESEL]");
    expect(sent).not.toMatch(/12431412345|500 000 201|jan\.testowy@|PL20 9999/);
    expect(out.redactions).toBeGreaterThan(0);
  });
});

describe("read_section", () => {
  it("the owning role reads the section; its text is cited as a search_result", async () => {
    const out = await runTool(ctx("hr"), "read_section", { doc_id: "hr-salary-bands", section: "Premia roczna" });
    expect(out.found).toBeGreaterThan(0);
    expect(asText(out.content)).toContain("18% w grupie G5");
  });

  it("not allowed looks exactly like not existing, whatever extra fields the model adds", async () => {
    const forbidden = await runTool(ctx("employee"), "read_section", { doc_id: "hr-salary-bands", section: "Premia roczna", role: "hr", is_admin: true });
    const missing = await runTool(ctx("employee"), "read_section", { doc_id: "no-such-document", section: "Premia roczna" });
    expect(forbidden).toEqual(missing);
    expect(asText(forbidden.content)).toBe("No such document or section is available to you.");
    expect(forbidden.found).toBe(0);
  });

  it("for a document the role may read, a wrong section name lists the real sections", async () => {
    const out = await runTool(ctx("employee"), "read_section", { doc_id: "gen-bhp-safety", section: "Nie ma takiej" });
    expect(asText(out.content)).toMatch(/^No such section\. Sections of this document: Przegląd; Szkolenia;/);
    expect(out.isError).toBe(false);
  });

  it("finds a section by anchor, by name or by part of the name", async () => {
    for (const s of ["pierwszy-dzien", "Pierwszy dzień", "pierwszy"]) {
      expect((await runTool(ctx("employee"), "read_section", { doc_id: "gen-onboarding-guide", section: s })).found, s).toBeGreaterThan(0);
    }
  });
});

describe("bad input from the model is an error result, not an exception", () => {
  const cases: [string, unknown][] = [
    ["search_text", undefined], ["search_text", null], ["search_text", "urlop"], ["search_text", {}], ["search_text", { query: "" }], ["search_text", { query: 5 }],
    ["search_text", { query: "x".repeat(201) }], ["search_text", { query: "urlop", limit: 0 }], ["search_text", { query: "urlop", limit: 9 }],
    ["search_text", { query: "urlop", limit: 1.5 }], ["search_text", { query: "urlop", limit: "3" }],
    ["read_section", {}], ["read_section", { doc_id: "x" }], ["read_section", { doc_id: 1, section: "y" }], ["read_section", { doc_id: "x".repeat(81), section: "y" }],
    ["list_documents", { department: 5 }], ["list_documents", { department: "x".repeat(61) }],
  ];
  for (const [name, input] of cases) {
    it(`${name} ${JSON.stringify(input)?.slice(0, 40)}`, async () => {
      const out = await runTool(ctx("employee"), name, input);
      expect(out.isError).toBe(true);
      expect(out.found).toBe(0);
      expect(typeof out.content).toBe("string");
    });
  }

  it("an unknown tool name gets an error that lists the real tools, and a hostile name is cut short", async () => {
    const out = await runTool(ctx("employee"), "drop_table_chunks; --".repeat(10), {});
    expect(out.isError).toBe(true);
    expect(asText(out.content)).toContain("list_documents, search_text, read_section");
    expect(asText(out.content).length).toBeLessThan(200);
  });

  it("hostile search text cannot break out of the query or reach other rows", async () => {
    const hostile = [`"; DROP TABLE chunks; --`, `' OR 1=1 --`, `x") OR ("1`, `* ( ) : ^ NEAR/2 AND OR NOT`, `"unterminated`];
    for (const q of hostile) {
      const out = await runTool(ctx("employee"), "search_text", { query: q });
      for (const c of out.chunks) expect(c.access_label).toBe("general");
    }
    expect((await db.prepare("SELECT COUNT(*) AS n FROM chunks").first<{ n: number }>())!.n).toBeGreaterThan(100);
  });
});
