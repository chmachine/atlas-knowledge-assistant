import { describe, expect, it } from "vitest";
import { loadCorpus } from "../scripts/check-corpus";
import { chunkDocument, chunkId, embeddingInput, slugify } from "../src/worker/ingest/chunker";
import { parseDocument } from "../src/worker/ingest/frontmatter";

const doc = { id: "doc", language: "pl" as const };

describe("slugify and chunk ids", () => {
  it("folds Polish letters and punctuation", () => {
    expect(slugify("Pierwszy dzień")).toBe("pierwszy-dzien");
    expect(slugify("Zaległy urlop: łączna / żółć!")).toBe("zalegly-urlop-laczna-zolc");
    expect(slugify("Węzeł > Źródło")).toBe("wezel-zrodlo");
    expect(slugify("???")).toBe("section");
  });

  it("keeps ids within the 64-byte Vectorize limit and unique when they have to be cut", () => {
    const longDoc = "a-very-long-document-identifier-that-keeps-going-and-going";
    const a = chunkId(longDoc, "a-section-with-a-very-long-heading-about-something-one");
    const b = chunkId(longDoc, "a-section-with-a-very-long-heading-about-something-two");
    expect(a.length).toBeLessThanOrEqual(64);
    expect(b.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
    expect(chunkId("short", "anchor")).toBe("short#anchor");
  });
});

describe("chunkDocument", () => {
  const body = `# Tytuł dokumentu

Wstęp pierwszy.

Wstęp drugi.

## Pierwszy dzień

Tekst pierwszego dnia.

| A | B |
|---|---|
| 1 | 2 |

## Opiekun

Tekst o opiekunie.

### Zakres

Szczegóły zakresu.

## Opiekun

Powtórzony nagłówek.

## Pusta sekcja

## Ostatnia

Koniec.`;

  const chunks = chunkDocument(doc, body);

  it("makes one chunk per section, with the introduction first and the H1 dropped", () => {
    expect(chunks.map((c) => c.sectionPath)).toEqual(["Przegląd", "Pierwszy dzień", "Opiekun", "Opiekun > Zakres", "Opiekun", "Ostatnia"]);
    expect(chunks[0]!.text).toBe("Wstęp pierwszy.\n\nWstęp drugi.");
    expect(chunks.map((c) => c.text).join("\n")).not.toContain("# Tytuł");
  });

  it("numbers chunks, makes anchors unique even for repeated headings, and skips empty sections", () => {
    expect(chunks.map((c) => c.ord)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(chunks.map((c) => c.anchor)).size).toBe(chunks.length);
    expect(chunks.map((c) => c.anchor)).toEqual(["przeglad", "pierwszy-dzien", "opiekun", "opiekun-zakres", "opiekun-2", "ostatnia"]);
    expect(chunks.every((c) => c.id === `doc#${c.anchor}`)).toBe(true);
  });

  it("keeps a table together with its section", () => {
    expect(chunks[1]!.text).toContain("| A | B |");
    expect(chunks[1]!.text).toContain("| 1 | 2 |");
  });

  it("labels the introduction in the document's language", () => {
    expect(chunkDocument({ id: "d", language: "en" }, "# T\n\nIntro.\n\n## One\n\nBody.")[0]!.sectionPath).toBe("Overview");
  });

  it("splits a long section at paragraph boundaries and numbers the parts", () => {
    const para = (n: number) => Array.from({ length: 60 }, (_, i) => `słowo${n}x${i}`).join(" ");
    const long = chunkDocument(doc, `# T\n\n## Długa\n\n${[1, 2, 3, 4, 5].map(para).join("\n\n")}`, { maxWords: 130 });
    expect(long.map((c) => c.anchor)).toEqual(["dluga", "dluga-2", "dluga-3"]);
    expect(long.every((c) => c.sectionPath === "Długa")).toBe(true);
    expect(long.every((c) => c.text.split(/\s+/).length <= 130)).toBe(true);
    expect(long.map((c) => c.text).join("\n\n")).toBe([1, 2, 3, 4, 5].map(para).join("\n\n"));
  });

  it("gives every chunk a token estimate and builds the text that gets embedded", () => {
    expect(chunks.every((c) => c.tokenEstimate > 0)).toBe(true);
    expect(embeddingInput("Tytuł", chunks[1]!)).toBe(`Tytuł\nPierwszy dzień\n\n${chunks[1]!.text}`);
  });
});

describe("the real corpus", () => {
  const all = loadCorpus().flatMap((f) => {
    const { meta, body } = parseDocument(f.raw);
    return chunkDocument(meta, body).map((c) => ({ docId: meta.id, ...c }));
  });

  it("produces a few hundred chunks, every id unique and within 64 bytes", () => {
    expect(all.length).toBeGreaterThan(150);
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    expect(all.every((c) => new TextEncoder().encode(c.id).length <= 64)).toBe(true);
  });

  it("never produces an empty chunk, and none longer than the limit", () => {
    for (const c of all) {
      expect(c.text.trim().length, c.id).toBeGreaterThan(20);
      expect(c.text.split(/\s+/).length, c.id).toBeLessThanOrEqual(250);
    }
  });

  it("gives every document at least four chunks", () => {
    const perDoc = new Map<string, number>();
    for (const c of all) perDoc.set(c.docId, (perDoc.get(c.docId) ?? 0) + 1);
    expect(perDoc.size).toBe(36);
    for (const [id, n] of perDoc) expect(n, id).toBeGreaterThanOrEqual(4);
  });
});
