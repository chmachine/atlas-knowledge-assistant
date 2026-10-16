import { describe, expect, it } from "vitest";
import { parseDocument } from "../src/worker/ingest/frontmatter";

const header = (over: Record<string, string> = {}) => {
  const base: Record<string, string> = {
    id: "hr-sample",
    title: "Przykładowy dokument",
    department: "HR",
    access: "hr",
    owner: "Anna Przykład",
    owner_role: "Specjalistka",
    version: "2",
    effective_date: "2026-01-02",
    supersedes: "hr-sample-v1",
    language: "pl",
    ...over,
  };
  return `---\n${Object.entries(base).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n# Tytuł\n\nTreść.\n`;
};

describe("front matter", () => {
  it("parses a valid document", () => {
    const { meta, body } = parseDocument(header());
    expect(meta).toMatchObject({ id: "hr-sample", access: "hr", version: 2, supersedes: "hr-sample-v1", language: "pl" });
    expect(body).toBe("# Tytuł\n\nTreść.");
  });

  it("treats empty and null supersedes as null, and strips quotes", () => {
    expect(parseDocument(header({ supersedes: "null" })).meta.supersedes).toBeNull();
    expect(parseDocument(header({ supersedes: "" })).meta.supersedes).toBeNull();
    expect(parseDocument(header({ title: '"Cytat: w tytule"' })).meta.title).toBe("Cytat: w tytule");
  });

  it("rejects an unknown access label (so a typo can never become a public document)", () => {
    expect(() => parseDocument(header({ access: "public" }))).toThrow(/access/);
    expect(() => parseDocument(header({ access: "HR" }))).toThrow(/access/);
  });

  it("rejects bad dates, versions, languages and ids", () => {
    expect(() => parseDocument(header({ effective_date: "01.02.2026" }))).toThrow(/effective_date/);
    expect(() => parseDocument(header({ version: "0" }))).toThrow(/version/);
    expect(() => parseDocument(header({ language: "de" }))).toThrow(/language/);
    expect(() => parseDocument(header({ id: "Bad Id" }))).toThrow(/id/);
  });

  it("rejects missing fences and malformed lines", () => {
    expect(() => parseDocument("# Tylko treść")).toThrow(/front matter/);
    expect(() => parseDocument("---\nnot a pair\n---\ntext")).toThrow(/bad front matter line/);
  });
});
