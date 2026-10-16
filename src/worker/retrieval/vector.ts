import { MIN_SIMILARITY, VECTOR_TOP_K } from "../../config";
import { vectorFilter } from "../access/policy";
import { chunkId } from "../ingest/chunker";
import { CONTACTS_DOC_ID } from "../answer/prompts";
import type { Embedder, VectorStore } from "./ports";
import { getChunksByIds, getDocumentChunks, type ChunkRow } from "./store";

export interface Retrieval {
  /** In the order they are given to the model: matches first, then version counterparts, then the contacts directory. */
  chunks: ChunkRow[];
  /** Chunks retrieval contributed (matches and version counterparts). The contacts directory is not counted. */
  relevantIds: string[];
  scores: Record<string, number>;
}

const MAX_COUNTERPARTS = 4;

/**
 * Vector retrieval for a question. The question must already be redacted.
 *  1. The vector query carries the role's label filter.
 *  2. The ids it returns are re-checked in SQL against the same policy (a faulty store cannot leak a chunk).
 *  3. Matches below the similarity threshold are dropped.
 *  4. Version counterparts are added: for a match in an outdated document its current version, and for a match in a current
 *     document the version it replaced, so the model sees both sides of a conflict, each marked CURRENT or OUTDATED.
 *  5. The contacts directory is always added, so the assistant can say who to ask even when nothing matched.
 */
export async function retrieveVector(
  deps: { db: D1Database; embedder: Embedder; vectors: VectorStore },
  role: string,
  question: string,
  opts: { minSimilarity?: number } = {},
): Promise<Retrieval> {
  const filter = vectorFilter(role);
  if (!filter) return { chunks: [], relevantIds: [], scores: {} }; // no access at all: nothing is queried

  const [vector] = await deps.embedder.embed([question]);
  if (!vector) throw new Error("embedder returned no vector");
  const matches = (await deps.vectors.query(vector, { topK: VECTOR_TOP_K, filter })).filter((m) => m.score >= (opts.minSimilarity ?? MIN_SIMILARITY));
  const scores = Object.fromEntries(matches.map((m) => [m.id, m.score]));

  const matched = await getChunksByIds(deps.db, role, matches.map((m) => m.id));
  const have = new Set(matched.map((c) => c.id));

  // Counterparts: same section anchor in the other version of the document.
  const wanted: string[] = [];
  for (const c of matched) {
    const otherDoc = c.is_latest ? c.supersedes : c.superseded_by;
    if (!otherDoc) continue;
    const id = chunkId(otherDoc, c.anchor);
    if (!have.has(id) && !wanted.includes(id)) wanted.push(id);
  }
  const counterparts = (await getChunksByIds(deps.db, role, wanted.slice(0, MAX_COUNTERPARTS))).filter((c) => !have.has(c.id));
  for (const c of counterparts) have.add(c.id);

  const contacts = ((await getDocumentChunks(deps.db, role, CONTACTS_DOC_ID)) ?? []).filter((c) => !have.has(c.id));
  const relevant = [...matched, ...counterparts];
  return { chunks: [...relevant, ...contacts], relevantIds: relevant.map((c) => c.id), scores };
}
