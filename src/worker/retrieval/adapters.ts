import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../../config";
import type { Env } from "../env";
import type { Embedder, VectorStore } from "./ports";

const EMBED_BATCH = 16;

type AiRunner = { run(model: string, input: unknown): Promise<unknown> };

/** Workers AI embeddings. Fails loudly on a wrong dimension, because a mismatched vector would corrupt the index silently. */
export function workersAiEmbedder(ai: Ai, model: string = EMBEDDING_MODEL): Embedder {
  const runner = ai as unknown as AiRunner;
  return {
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const batch = texts.slice(i, i + EMBED_BATCH);
        const res = (await runner.run(model, { text: batch })) as { data?: number[][] };
        if (!Array.isArray(res?.data) || res.data.length !== batch.length) throw new Error("embedding: unexpected response shape");
        for (const v of res.data) {
          if (!Array.isArray(v) || v.length !== EMBEDDING_DIMENSIONS) throw new Error(`embedding: expected ${EMBEDDING_DIMENSIONS} dimensions, got ${v?.length}`);
        }
        out.push(...res.data);
      }
      return out;
    },
  };
}

const UPSERT_BATCH = 100;

export function vectorizeStore(index: VectorizeIndex): VectorStore {
  return {
    async upsert(records) {
      for (let i = 0; i < records.length; i += UPSERT_BATCH) {
        await index.upsert(records.slice(i, i + UPSERT_BATCH).map((r) => ({ id: r.id, values: r.values, metadata: r.metadata })));
      }
    },
    async deleteByIds(ids) {
      for (let i = 0; i < ids.length; i += UPSERT_BATCH) await index.deleteByIds(ids.slice(i, i + UPSERT_BATCH));
    },
    async query(vector, opts) {
      // Metadata is not requested: D1 is the source of truth for text and for the permission re-check.
      const res = await index.query(vector, { topK: opts.topK, filter: opts.filter as VectorizeVectorMetadataFilter, returnMetadata: "none", returnValues: false });
      return res.matches.map((m) => ({ id: m.id, score: m.score }));
    },
  };
}

/** Adapters for whatever bindings exist. Both are undefined until the cloud resources have been created. */
export function retrievalDeps(env: Env): { embedder?: Embedder; vectors?: VectorStore } {
  return {
    embedder: env.AI ? workersAiEmbedder(env.AI) : undefined,
    vectors: env.VECTORIZE ? vectorizeStore(env.VECTORIZE) : undefined,
  };
}
