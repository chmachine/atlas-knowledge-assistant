import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadCorpus } from "../scripts/check-corpus";
import { canAccess } from "../src/worker/access/policy";
import { CANARY } from "../src/worker/ingest/corpus-check";
import { parseDocument } from "../src/worker/ingest/frontmatter";
import { evalCaseSchema } from "../src/worker/eval/schema";

// The ground truth of the evaluation is checked against the corpus itself, so a wrong "expected fact" cannot make a good answer look bad.

const cases = (JSON.parse(readFileSync("eval/cases.json", "utf8")) as unknown[]).map((c) => evalCaseSchema.parse(c));
const docs = new Map(loadCorpus().map((f) => parseDocument(f.raw)).map((d) => [d.meta.id, d]));
const bodyOf = (id: string) => docs.get(id)!.body;
const norm = (s: string) => s.replace(/\s+/g, " ");

describe("eval/cases.json", () => {
  it("has 40 cases with the planned mix, unique ids and valid roles", () => {
    expect(cases).toHaveLength(40);
    expect(new Set(cases.map((c) => c.id)).size).toBe(40);
    const count = (cat: string) => cases.filter((c) => c.category === cat).length;
    expect([count("answerable"), count("redaction"), count("conflict"), count("injection"), count("blocked"), count("out_of_scope")]).toEqual([22, 2, 3, 2, 6, 5]);
    expect(new Set(cases.map((c) => c.role))).toEqual(new Set(["employee", "hr", "finance", "it_ops"]));
    expect(cases.some((c) => /^[A-Za-z ,?'-]+$/.test(c.question))).toBe(true); // some questions are in English
  });

  it("refusals have no expected documents; every other case has some, they exist, and the asking role may read them", () => {
    for (const c of cases) {
      const mustRefuse = c.category === "blocked" || c.category === "out_of_scope";
      expect(c.expect_refusal, c.id).toBe(mustRefuse);
      expect(c.expected_docs.length > 0, c.id).toBe(!mustRefuse);
      for (const d of c.expected_docs) {
        expect(docs.has(d), `${c.id}: ${d} exists`).toBe(true);
        expect(canAccess(c.role, docs.get(d)!.meta.access), `${c.id}: ${c.role} may read ${d}`).toBe(true);
      }
    }
  });

  it("every key fact is backed by an exact phrase in an expected document", () => {
    for (const c of cases) {
      expect(c.key_facts.length > 0, `${c.id} has facts`).toBe(!c.expect_refusal);
      for (const f of c.key_facts) {
        expect(c.expected_docs.some((d) => norm(bodyOf(d)).includes(norm(f.evidence))), `${c.id}: "${f.evidence}"`).toBe(true);
      }
    }
  });

  it("conflict cases cite the current document as expected and carry the older version's fact, with evidence from the older document", () => {
    const conflicts = cases.filter((c) => c.category === "conflict");
    for (const c of conflicts) {
      expect(c.older, c.id).toBeDefined();
      expect(docs.get(c.older!.doc)!.meta.supersedes === null, `${c.id}: older doc is the original`).toBe(true);
      expect(norm(bodyOf(c.older!.doc)).includes(norm(c.older!.evidence)), c.id).toBe(true);
      expect(docs.get(c.expected_docs[0]!)!.meta.supersedes, c.id).toBe(c.older!.doc);
    }
    expect(cases.filter((c) => c.older && c.category !== "conflict")).toEqual([]);
  });

  it("forbidden strings are real: restricted facts exist only where the role may not read, personal data and the canary are in the corpus", () => {
    for (const c of cases.filter((x) => x.category === "blocked")) {
      expect(c.must_not_contain.length, c.id).toBeGreaterThan(0);
      for (const s of c.must_not_contain) {
        const holders = [...docs.values()].filter((d) => norm(d.body).includes(norm(s)));
        expect(holders.length, `${c.id}: "${s}" exists in the corpus`).toBeGreaterThan(0);
        expect(holders.some((d) => canAccess(c.role, d.meta.access)), `${c.id}: "${s}" must not be readable by ${c.role}`).toBe(false);
      }
    }
    for (const c of cases.filter((x) => x.category === "redaction" || x.category === "injection")) {
      expect(c.must_not_contain.length, c.id).toBeGreaterThan(0);
      for (const s of c.must_not_contain) expect([...docs.values()].some((d) => norm(d.body).includes(norm(s))), `${c.id}: "${s}"`).toBe(true);
    }
    expect(cases.filter((c) => c.category === "injection").every((c) => c.must_not_contain.includes(CANARY))).toBe(true);
  });
});
