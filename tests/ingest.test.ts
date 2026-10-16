import { describe, expect, it } from "vitest";
import { loadCorpus } from "../scripts/check-corpus";
import { findPii } from "../src/worker/ingest/corpus-check";
import { ingestDocument, type IngestDeps } from "../src/worker/ingest/indexer";
import { searchChunks } from "../src/worker/retrieval/store";
import { makeDb } from "./d1";
import { FakeEmbedder, FakeVectorStore } from "./fakes";

const corpus = loadCorpus();
const raw = (id: string) => corpus.find((f) => f.path.endsWith(`/${id}.md`))!.raw;

function setup() {
  const db = makeDb();
  const embedder = new FakeEmbedder();
  const vectors = new FakeVectorStore();
  const deps: IngestDeps = { db, embedder, vectors };
  return { db, embedder, vectors, deps };
}
async function ingestAll(deps: IngestDeps) {
  const results = [];
  for (const f of corpus) results.push(await ingestDocument(deps, f.raw));
  return results;
}
const count = async (db: D1Database, sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;

describe("ingesting the corpus", () => {
  it("stores 36 documents and their chunks, and puts one vector per chunk in the vector store", async () => {
    const { db, vectors, deps } = setup();
    const results = await ingestAll(deps);
    expect(results.every((r) => r.status === "created")).toBe(true);
    expect(await count(db, "SELECT COUNT(*) AS n FROM documents")).toBe(36);
    const chunks = await count(db, "SELECT COUNT(*) AS n FROM chunks");
    expect(chunks).toBeGreaterThan(150);
    expect(vectors.records.size).toBe(chunks);
    expect(await count(db, "SELECT COUNT(*) AS n FROM documents WHERE embedded = 1")).toBe(36);
    expect(await count(db, "SELECT COUNT(*) AS n FROM chunks_fts")).toBe(chunks);
  });

  it("writes vector metadata that matches the document: id, section and access label", async () => {
    const { db, vectors, deps } = setup();
    await ingestAll(deps);
    const rows = (await db.prepare("SELECT c.id, c.doc_id, c.section_path, d.access_label FROM chunks c JOIN documents d ON d.id = c.doc_id").all<{ id: string; doc_id: string; section_path: string; access_label: string }>()).results;
    for (const r of rows) expect(vectors.records.get(r.id)?.metadata).toEqual({ doc_id: r.doc_id, section: r.section_path, access_label: r.access_label });
    expect(new Set([...vectors.records.values()].map((v) => v.metadata.access_label))).toEqual(new Set(["general", "it", "security", "hr", "finance"]));
  });

  it("works out which version is the latest, for all three conflicting pairs", async () => {
    const { db, deps } = setup();
    await ingestAll(deps);
    const rows = (await db.prepare("SELECT id, is_latest, superseded_by FROM documents WHERE id LIKE '%-v1' OR id LIKE '%-v2' ORDER BY id").all<{ id: string; is_latest: number; superseded_by: string | null }>()).results;
    expect(rows).toEqual([
      { id: "fin-expense-policy-v1", is_latest: 0, superseded_by: "fin-expense-policy-v2" },
      { id: "fin-expense-policy-v2", is_latest: 1, superseded_by: null },
      { id: "gen-remote-work-v1", is_latest: 0, superseded_by: "gen-remote-work-v2" },
      { id: "gen-remote-work-v2", is_latest: 1, superseded_by: null },
      { id: "sec-password-policy-v1", is_latest: 0, superseded_by: "sec-password-policy-v2" },
      { id: "sec-password-policy-v2", is_latest: 1, superseded_by: null },
    ]);
    expect(await count(db, "SELECT COUNT(*) AS n FROM documents WHERE is_latest = 0")).toBe(3);
  });

  it("resolves versions even when the newer document is ingested first", async () => {
    const { db, deps } = setup();
    await ingestDocument(deps, raw("gen-remote-work-v2"));
    await ingestDocument(deps, raw("gen-remote-work-v1"));
    expect((await db.prepare("SELECT is_latest, superseded_by FROM documents WHERE id = 'gen-remote-work-v1'").first())).toEqual({ is_latest: 0, superseded_by: "gen-remote-work-v2" });
  });

  it("flags exactly one chunk as a suspected injection, in the IT FAQ", async () => {
    const { db, deps } = setup();
    const results = await ingestAll(deps);
    expect(results.reduce((n, r) => n + r.flagged, 0)).toBe(1);
    const flagged = (await db.prepare("SELECT doc_id, section_path FROM chunks WHERE injection_flag = 1").all<{ doc_id: string; section_path: string }>()).results;
    expect(flagged).toEqual([{ doc_id: "gen-it-faq", section_path: "Drukowanie" }]);
  });
});

describe("personal data on the way out", () => {
  it("never sends personal data to the embedder, but still embeds the surrounding text", async () => {
    const { embedder, deps } = setup();
    const results = await ingestAll(deps);
    const sent = embedder.seen.join("\n");
    expect(findPii(sent)).toEqual({ emails: [], phones: [], pesels: [], ibans: [] });
    expect(sent).toContain("[PESEL]");
    expect(sent).toContain("[IBAN]");
    expect(sent).toContain("Jan Testowy"); // names are not redacted; that is a documented limit
    expect(results.reduce((n, r) => n + r.redacted, 0)).toBe(4 + 4 + 1 + 1 + 1 + 1 + 3 + 3 + 3 + 0 + 0); // emails/phones/pesel/iban per planted doc
  });

  it("keeps the raw text in the database (the document store); redaction is applied on every way out", async () => {
    const { db, deps } = setup();
    await ingestAll(deps);
    const row = await db.prepare("SELECT body_md FROM documents WHERE id = 'hr-employee-file-template'").first<{ body_md: string }>();
    expect(row!.body_md).toContain("12431412345");
  });
});

describe("re-ingesting", () => {
  it("is idempotent: an unchanged corpus changes nothing and calls the embedder and vector store not at all", async () => {
    const { embedder, vectors, deps } = setup();
    await ingestAll(deps);
    const calls = embedder.calls;
    const upserts = vectors.upserts;
    const again = await ingestAll(deps);
    expect(again.every((r) => r.status === "unchanged")).toBe(true);
    expect(embedder.calls).toBe(calls);
    expect(vectors.upserts).toBe(upserts);
  });

  it("replaces the chunks of a changed document, drops vectors of removed sections and updates full-text search", async () => {
    const { db, vectors, deps } = setup();
    await ingestDocument(deps, raw("gen-bhp-safety"));
    const before = [...vectors.records.keys()].filter((id) => id.startsWith("gen-bhp-safety#"));
    expect(before).toContain("gen-bhp-safety#zglaszanie-zagrozen");

    const edited = raw("gen-bhp-safety").replace(/## Zgłaszanie zagrożeń[\s\S]*$/, "## Nowa sekcja\n\nTekst o kwarantannie magazynowej zupełnie nowy.\n");
    const result = await ingestDocument(deps, edited);
    expect(result.status).toBe("updated");

    const after = [...vectors.records.keys()].filter((id) => id.startsWith("gen-bhp-safety#"));
    expect(after).not.toContain("gen-bhp-safety#zglaszanie-zagrozen");
    expect(after).toContain("gen-bhp-safety#nowa-sekcja");
    expect(await count(db, "SELECT COUNT(*) AS n FROM chunks WHERE doc_id = 'gen-bhp-safety'")).toBe(after.length);
    expect((await searchChunks(db, "employee", "kwarantannie")).map((h) => h.doc_id)).toContain("gen-bhp-safety");
    expect(await searchChunks(db, "employee", "cotygodniowej")).toEqual([]); // a word that only the removed section contained
  });

  it("recovers after a failure part-way: the document is marked not embedded and the next run finishes the job", async () => {
    const { db, embedder, vectors, deps } = setup();
    embedder.failNext = true;
    await expect(ingestDocument(deps, raw("hr-leave-policy"))).rejects.toThrow("embedder down");
    expect(await count(db, "SELECT COUNT(*) AS n FROM documents WHERE id = 'hr-leave-policy' AND embedded = 0")).toBe(1);
    expect(vectors.records.size).toBe(0);
    const retry = await ingestDocument(deps, raw("hr-leave-policy"));
    expect(retry.vectors).toBeGreaterThan(0);
    expect(await count(db, "SELECT COUNT(*) AS n FROM documents WHERE id = 'hr-leave-policy' AND embedded = 1")).toBe(1);
  });

  it("indexes for full-text search alone when no embedder is configured, and embeds later without re-reading anything new", async () => {
    const { db, embedder, vectors } = setup();
    const textOnly: IngestDeps = { db };
    expect((await ingestDocument(textOnly, raw("hr-leave-policy"))).vectors).toBe(0);
    expect(await count(db, "SELECT COUNT(*) AS n FROM documents WHERE embedded = 1")).toBe(0);
    const upgraded = await ingestDocument({ db, embedder, vectors }, raw("hr-leave-policy"));
    expect(upgraded.vectors).toBeGreaterThan(0);
    expect(await count(db, "SELECT COUNT(*) AS n FROM documents WHERE embedded = 1")).toBe(1);
  });
});

describe("bad input", () => {
  it("rejects a document with missing or invalid front matter and writes nothing", async () => {
    const { db, deps } = setup();
    await expect(ingestDocument(deps, "# Bez nagłówka\n\nTekst")).rejects.toThrow(/front matter/);
    await expect(ingestDocument(deps, raw("hr-sick-leave").replace("access: hr", "access: public"))).rejects.toThrow(/access/);
    expect(await count(db, "SELECT COUNT(*) AS n FROM documents")).toBe(0);
  });

  it("refuses vectors of the wrong size instead of corrupting the index", async () => {
    const { db, vectors } = setup();
    const bad = { embed: async (t: string[]) => t.map(() => [1, 2, 3]) };
    await expect(ingestDocument({ db, embedder: bad, vectors }, raw("hr-sick-leave"))).rejects.toThrow(/wrong number or size/);
    expect(vectors.records.size).toBe(0);
  });
});
