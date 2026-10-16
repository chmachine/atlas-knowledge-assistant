// Splits a Markdown document into chunks by heading. One chunk per section, long sections split on paragraph boundaries.
// The heading is kept in `sectionPath` (not in the text), so a citation can say "Document title, Section".

export interface Chunk {
  /** "<doc id>#<anchor>", at most 64 bytes (the Vectorize vector id limit). */
  id: string;
  ord: number;
  /** "Section" or "Section > Subsection". */
  sectionPath: string;
  anchor: string;
  text: string;
  tokenEstimate: number;
}

const POLISH: Record<string, string> = { ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z" };

export function slugify(input: string): string {
  const folded = input.toLowerCase().replace(/[ąćęłńóśźż]/g, (c) => POLISH[c] ?? c).normalize("NFD").replace(/[̀-ͯ]/g, "");
  return folded.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";
}

/** Stable chunk id within the 64-byte limit: long ids are cut and get a short hash so they stay unique. */
export function chunkId(docId: string, anchor: string): string {
  const full = `${docId}#${anchor}`;
  if (full.length <= 64) return full;
  let h = 5381;
  for (const ch of full) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return `${full.slice(0, 55)}~${h.toString(36).padStart(6, "0").slice(0, 8)}`.slice(0, 64);
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

interface Section {
  path: string[];
  lines: string[];
}

/** Paragraphs are separated by blank lines; a table counts as one paragraph. */
function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

function splitLong(text: string, maxWords: number): string[] {
  if (words(text) <= maxWords) return [text];
  const parts: string[] = [];
  let current: string[] = [];
  let count = 0;
  for (const p of paragraphs(text)) {
    const n = words(p);
    if (current.length && count + n > maxWords) {
      parts.push(current.join("\n\n"));
      current = [];
      count = 0;
    }
    current.push(p);
    count += n;
  }
  if (current.length) parts.push(current.join("\n\n"));
  return parts;
}

export function chunkDocument(doc: { id: string; language: "pl" | "en" }, body: string, opts: { maxWords?: number } = {}): Chunk[] {
  const maxWords = opts.maxWords ?? 250;
  const overview = doc.language === "en" ? "Overview" : "Przegląd";

  const sections: Section[] = [{ path: [overview], lines: [] }];
  let h2: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const m2 = /^##\s+(.+?)\s*$/.exec(line);
    const m3 = /^###\s+(.+?)\s*$/.exec(line);
    if (/^#\s/.test(line) && sections.length === 1 && sections[0]!.lines.every((l) => !l.trim())) continue; // the H1 repeats the title
    if (m2) {
      h2 = m2[1]!;
      sections.push({ path: [h2], lines: [] });
    } else if (m3 && h2) {
      sections.push({ path: [h2, m3[1]!], lines: [] });
    } else {
      sections[sections.length - 1]!.lines.push(line);
    }
  }

  const chunks: Chunk[] = [];
  const usedAnchors = new Set<string>();
  for (const section of sections) {
    const text = section.lines.join("\n").trim();
    if (!text) continue;
    const sectionPath = section.path.join(" > ");
    const baseAnchor = slugify(section.path.join(" "));
    splitLong(text, maxWords).forEach((part, i) => {
      let anchor = i === 0 ? baseAnchor : `${baseAnchor}-${i + 1}`;
      for (let n = 2; usedAnchors.has(anchor); n++) anchor = `${baseAnchor}-${n}`;
      usedAnchors.add(anchor);
      chunks.push({ id: chunkId(doc.id, anchor), ord: chunks.length, sectionPath, anchor, text: part, tokenEstimate: estimateTokens(part) });
    });
  }
  return chunks;
}

/** Text that is embedded for a chunk: the title and section give the passage its context. */
export const embeddingInput = (title: string, chunk: Pick<Chunk, "sectionPath" | "text">) => `${title}\n${chunk.sectionPath}\n\n${chunk.text}`;
