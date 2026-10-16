import { EMBEDDING_DIMENSIONS } from "../../config";
import { scanForInjection } from "../governance/injection";
import { redact, redactText } from "../governance/redact";
import type { Embedder, VectorStore } from "../retrieval/ports";
import { sha256Hex } from "../util/crypto";
import { chunkDocument, embeddingInput } from "./chunker";
import { parseDocument } from "./frontmatter";

export interface IngestDeps {
  db: D1Database;
  /** Both must be present for vectors to be written. Without them the document is indexed for full-text search only. */
  embedder?: Embedder;
  vectors?: VectorStore;
  now?: () => Date;
}

export interface IngestResult {
  id: string;
  status: "created" | "updated" | "unchanged";
  chunks: number;
  vectors: number;
  /** Chunks the injection tripwire flagged. */
  flagged: number;
  /** Personal-data items removed from the text that was sent to the embedder. */
  redacted: number;
}

const VECTOR_BATCH = 100;

/** Derives superseded_by and is_latest for every document from the `supersedes` pointers. */
export async function resolveVersions(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("UPDATE documents SET superseded_by = (SELECT n.id FROM documents n WHERE n.supersedes = documents.id LIMIT 1)"),
    db.prepare("UPDATE documents SET is_latest = CASE WHEN superseded_by IS NULL THEN 1 ELSE 0 END"),
  ]);
}

export async function ingestDocument(deps: IngestDeps, raw: string, opts: { force?: boolean } = {}): Promise<IngestResult> {
  const { db } = deps;
  const { meta, body } = parseDocument(raw);
  const hash = await sha256Hex(raw);
  const wantVectors = Boolean(deps.embedder && deps.vectors);

  const existing = await db
    .prepare("SELECT content_hash, embedded FROM documents WHERE id = ?")
    .bind(meta.id)
    .first<{ content_hash: string; embedded: number }>();
  const unchanged = existing?.content_hash === hash && !opts.force;
  const chunks = chunkDocument(meta, body);
  const flags = chunks.map((c) => scanForInjection(c.text).flagged);

  if (unchanged && (!wantVectors || existing?.embedded === 1)) {
    return { id: meta.id, status: "unchanged", chunks: chunks.length, vectors: 0, flagged: flags.filter(Boolean).length, redacted: 0 };
  }

  const oldIds = existing ? (await db.prepare("SELECT id FROM chunks WHERE doc_id = ?").bind(meta.id).all<{ id: string }>()).results.map((r) => r.id) : [];
  const nowIso = (deps.now?.() ?? new Date()).toISOString();

  // One transaction: the document row, then its chunks (the triggers keep the full-text index in step).
  await db.batch([
    db
      .prepare(
        `INSERT INTO documents (id, title, department, access_label, owner_name, owner_role, version, effective_date, supersedes, language, body_md, content_hash, embedded, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT (id) DO UPDATE SET
           title = excluded.title, department = excluded.department, access_label = excluded.access_label,
           owner_name = excluded.owner_name, owner_role = excluded.owner_role, version = excluded.version,
           effective_date = excluded.effective_date, supersedes = excluded.supersedes, language = excluded.language,
           body_md = excluded.body_md, content_hash = excluded.content_hash, embedded = 0, ingested_at = excluded.ingested_at`,
      )
      .bind(meta.id, meta.title, meta.department, meta.access, meta.owner, meta.owner_role, meta.version, meta.effective_date, meta.supersedes, meta.language, body, hash, nowIso),
    db.prepare("DELETE FROM chunks WHERE doc_id = ?").bind(meta.id),
    ...chunks.map((c, i) =>
      db
        .prepare(
          `INSERT INTO chunks (id, doc_id, ord, title, section_path, anchor, text, access_label, injection_flag, token_estimate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(c.id, meta.id, c.ord, meta.title, c.sectionPath, c.anchor, c.text, meta.access, flags[i] ? 1 : 0, c.tokenEstimate),
    ),
  ]);
  await resolveVersions(db);

  let vectorCount = 0;
  let redacted = 0;
  if (wantVectors) {
    // What is embedded is the redacted text: personal data never leaves the database toward an outside service.
    const inputs = chunks.map((c) => embeddingInput(meta.title, c));
    redacted = inputs.reduce((n, t) => n + redact(t).total, 0);
    const values = await deps.embedder!.embed(inputs.map(redactText));
    if (values.length !== chunks.length || values.some((v) => v.length !== EMBEDDING_DIMENSIONS)) throw new Error("embedder returned the wrong number or size of vectors");
    await deps.vectors!.upsert(chunks.map((c, i) => ({ id: c.id, values: values[i]!, metadata: { doc_id: meta.id, section: c.sectionPath, access_label: meta.access } })));
    const stale = oldIds.filter((id) => !chunks.some((c) => c.id === id));
    for (let i = 0; i < stale.length; i += VECTOR_BATCH) await deps.vectors!.deleteByIds(stale.slice(i, i + VECTOR_BATCH));
    await db.prepare("UPDATE documents SET embedded = 1 WHERE id = ?").bind(meta.id).run();
    vectorCount = chunks.length;
  }

  return {
    id: meta.id,
    status: existing ? "updated" : "created",
    chunks: chunks.length,
    vectors: vectorCount,
    flagged: flags.filter(Boolean).length,
    redacted,
  };
}
