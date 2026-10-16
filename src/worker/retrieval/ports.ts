// The two outside services retrieval depends on, as small interfaces. Real adapters wrap Workers AI and Vectorize;
// tests plug in in-memory fakes, so the permission logic can be exercised without any cloud resource.

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export interface VectorRecord {
  /** Chunk id. */
  id: string;
  values: number[];
  metadata: { doc_id: string; section: string; access_label: string };
}

export interface VectorMatch {
  id: string;
  /** Cosine similarity, higher is closer. */
  score: number;
}

export interface VectorStore {
  upsert(records: VectorRecord[]): Promise<void>;
  deleteByIds(ids: string[]): Promise<void>;
  query(vector: number[], opts: { topK: number; filter: Record<string, unknown> }): Promise<VectorMatch[]>;
}
