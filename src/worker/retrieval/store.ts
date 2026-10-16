import { sqlLabels } from "../access/policy";
import { slugify } from "../ingest/chunker";

// Every read of document content goes through this file, and every function takes the caller's role and applies the access
// labels inside the SQL itself. Rows a role may not read are never selected, so they cannot reach the model, the logs or the screen.
// Callers pass the role from the server-side session. A role with no access gets an empty result without any query being run.
// "Not found" and "not allowed" are indistinguishable by design: the existence of a restricted document is not revealed.

export interface ChunkRow {
  id: string;
  doc_id: string;
  title: string;
  section_path: string;
  anchor: string;
  text: string;
  access_label: string;
  injection_flag: boolean;
  is_latest: boolean;
  superseded_by: string | null;
  supersedes: string | null;
  owner_name: string;
  owner_role: string;
  department: string;
  version: number;
  effective_date: string;
  language: string;
}

export interface DocSummary {
  id: string;
  title: string;
  department: string;
  owner_name: string;
  owner_role: string;
  version: number;
  effective_date: string;
  is_latest: boolean;
  superseded_by: string | null;
  language: string;
  access_label: string;
}

const CHUNK_COLUMNS = `c.id, c.doc_id, c.title, c.section_path, c.anchor, c.text, c.access_label, c.injection_flag,
  d.is_latest, d.superseded_by, d.supersedes, d.owner_name, d.owner_role, d.department, d.version, d.effective_date, d.language`;

type RawChunk = Omit<ChunkRow, "injection_flag" | "is_latest"> & { injection_flag: number; is_latest: number };
const toChunk = (r: RawChunk): ChunkRow => ({ ...r, injection_flag: r.injection_flag === 1, is_latest: r.is_latest === 1 });

/** Chunks by id, for the ids a vector search returned. The role is re-checked here even though the vector query was filtered. */
export async function getChunksByIds(db: D1Database, role: string, ids: string[]): Promise<ChunkRow[]> {
  const labels = sqlLabels(role, "c.access_label");
  if (!labels || ids.length === 0) return [];
  const unique = [...new Set(ids)].slice(0, 50);
  const { results } = await db
    .prepare(`SELECT ${CHUNK_COLUMNS} FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE c.id IN (${unique.map(() => "?").join(", ")}) AND ${labels.clause}`)
    .bind(...unique, ...labels.params)
    .all<RawChunk>();
  const order = new Map(unique.map((id, i) => [id, i]));
  return results.map(toChunk).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

const STOPWORDS = new Set([
  "jest", "czy", "jak", "jakie", "jaki", "jaka", "jakiej", "ile", "gdzie", "kiedy", "kto", "kogo", "nie", "dla", "przy", "oraz", "mam", "moge", "mogę", "trzeba", "należy",
  "the", "and", "what", "how", "who", "when", "where", "are", "does", "for", "can", "with", "which", "should",
]);

/** Light stemming for Polish inflection: trigram matching is by substring, so cutting a few letters finds more word forms. */
function stem(term: string): string {
  if (term.length >= 7) return term.slice(0, -2);
  if (term.length >= 5) return term.slice(0, -1);
  return term;
}

/** Turns free text into a safe FTS5 query: quoted terms joined by OR. Null when there is nothing searchable. */
export function ftsQuery(text: string): string | null {
  const terms = (text.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((t) => !STOPWORDS.has(t));
  const unique = [...new Set(terms.map(stem))].slice(0, 12);
  return unique.length ? unique.map((t) => `"${t}"`).join(" OR ") : null;
}

export interface SearchHit extends ChunkRow {
  /** Higher is a better match. */
  rank: number;
}

/** Full-text search (bm25; title and section weigh more than body text), restricted to the role's labels in the same statement. */
export async function searchChunks(db: D1Database, role: string, query: string, limit = 8): Promise<SearchHit[]> {
  const labels = sqlLabels(role, "c.access_label");
  const match = ftsQuery(query);
  if (!labels || !match) return [];
  const { results } = await db
    .prepare(
      `SELECT ${CHUNK_COLUMNS}, -bm25(chunks_fts, 4.0, 2.0, 1.0) AS rank
       FROM chunks_fts
       JOIN chunks c ON c.rowid = chunks_fts.rowid
       JOIN documents d ON d.id = c.doc_id
       WHERE chunks_fts MATCH ? AND ${labels.clause}
       ORDER BY rank DESC LIMIT ?`,
    )
    .bind(match, ...labels.params, Math.min(Math.max(limit, 1), 20))
    .all<RawChunk & { rank: number }>();
  return results.map((r) => ({ ...toChunk(r), rank: r.rank }));
}

export async function listDocuments(db: D1Database, role: string, opts: { department?: string } = {}): Promise<DocSummary[]> {
  const labels = sqlLabels(role, "access_label");
  if (!labels) return [];
  const dept = opts.department?.trim();
  const { results } = await db
    .prepare(
      `SELECT id, title, department, owner_name, owner_role, version, effective_date, is_latest, superseded_by, language, access_label
       FROM documents WHERE ${labels.clause}${dept ? " AND lower(department) = lower(?)" : ""} ORDER BY department, title`,
    )
    .bind(...labels.params, ...(dept ? [dept] : []))
    .all<Omit<DocSummary, "is_latest"> & { is_latest: number }>();
  return results.map((r) => ({ ...r, is_latest: r.is_latest === 1 }));
}

/** All chunks of a document the role may read, in order. Null when it does not exist or the role may not read it. */
export async function getDocumentChunks(db: D1Database, role: string, docId: string): Promise<ChunkRow[] | null> {
  const labels = sqlLabels(role, "c.access_label");
  if (!labels) return null;
  const { results } = await db
    .prepare(`SELECT ${CHUNK_COLUMNS} FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE c.doc_id = ? AND ${labels.clause} ORDER BY c.ord`)
    .bind(docId, ...labels.params)
    .all<RawChunk>();
  return results.length ? results.map(toChunk) : null;
}

/** The chunks of one section, found by anchor or by (part of) the section name. Null when not found or not allowed. */
export async function readSection(db: D1Database, role: string, docId: string, section: string): Promise<ChunkRow[] | null> {
  const chunks = await getDocumentChunks(db, role, docId);
  if (!chunks) return null;
  const wanted = slugify(section);
  if (!wanted) return null;
  const same = (c: ChunkRow) => c.anchor === wanted || slugify(c.section_path) === wanted || slugify(c.section_path.split(" > ")[0] ?? "") === wanted;
  const found = chunks.filter(same);
  if (found.length) return found;
  const partial = chunks.filter((c) => slugify(c.section_path).includes(wanted) || c.anchor.startsWith(wanted));
  return partial.length ? partial : null;
}

/** Titles of documents the role may read, by id. Ids the role cannot read are simply absent. */
export async function getDocTitles(db: D1Database, role: string, ids: string[]): Promise<Map<string, string>> {
  const labels = sqlLabels(role, "access_label");
  const unique = [...new Set(ids)].slice(0, 50);
  if (!labels || unique.length === 0) return new Map();
  const { results } = await db
    .prepare(`SELECT id, title FROM documents WHERE id IN (${unique.map(() => "?").join(", ")}) AND ${labels.clause}`)
    .bind(...unique, ...labels.params)
    .all<{ id: string; title: string }>();
  return new Map(results.map((r) => [r.id, r.title]));
}
