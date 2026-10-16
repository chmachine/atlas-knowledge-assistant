import { describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../src/config";
import { retrievalDeps, vectorizeStore, workersAiEmbedder } from "../src/worker/retrieval/adapters";

const vec = () => new Array<number>(EMBEDDING_DIMENSIONS).fill(0.5);

describe("Workers AI embedder", () => {
  it("calls the configured model in batches of 16 with { text: [...] } and returns vectors in order", async () => {
    const calls: { model: string; input: { text: string[] } }[] = [];
    const ai = { run: async (model: string, input: { text: string[] }) => (calls.push({ model, input }), { shape: [input.text.length, EMBEDDING_DIMENSIONS], data: input.text.map(() => vec()) }) };
    const out = await workersAiEmbedder(ai as never).embed(Array.from({ length: 40 }, (_, i) => `t${i}`));
    expect(out).toHaveLength(40);
    expect(calls.map((c) => c.input.text.length)).toEqual([16, 16, 8]);
    expect(calls.every((c) => c.model === EMBEDDING_MODEL)).toBe(true);
    expect(calls[2]!.input.text[0]).toBe("t32");
  });

  it("fails loudly on a wrong dimension, wrong count or odd response, so the index is never corrupted silently", async () => {
    const make = (res: unknown) => workersAiEmbedder({ run: async () => res } as never);
    await expect(make({ data: [[1, 2, 3]] }).embed(["a"])).rejects.toThrow(/dimensions/);
    await expect(make({ data: [vec(), vec()] }).embed(["a"])).rejects.toThrow(/shape/);
    await expect(make({}).embed(["a"])).rejects.toThrow(/shape/);
    await expect(make(null).embed(["a"])).rejects.toThrow(/shape/);
  });
});

describe("Vectorize store", () => {
  function fakeIndex() {
    const log = { upserts: [] as unknown[][], deletes: [] as string[][], query: null as null | { vector: number[]; options: Record<string, unknown> } };
    const index = {
      upsert: async (v: unknown[]) => void log.upserts.push(v),
      deleteByIds: async (ids: string[]) => void log.deletes.push(ids),
      query: async (vector: number[], options: Record<string, unknown>) => ((log.query = { vector, options }), { count: 2, matches: [{ id: "a", score: 0.9 }, { id: "b", score: 0.5 }] }),
    };
    return { index, log };
  }

  it("upserts and deletes in batches of at most 100", async () => {
    const { index, log } = fakeIndex();
    const store = vectorizeStore(index as never);
    await store.upsert(Array.from({ length: 250 }, (_, i) => ({ id: `c${i}`, values: [0], metadata: { doc_id: "d", section: "s", access_label: "general" } })));
    await store.deleteByIds(Array.from({ length: 101 }, (_, i) => `c${i}`));
    expect(log.upserts.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(log.deletes.map((b) => b.length)).toEqual([100, 1]);
  });

  it("queries with the filter it was given, asks for no metadata or values, and returns ids with scores", async () => {
    const { index, log } = fakeIndex();
    const filter = { access_label: { $in: ["general", "hr"] } };
    const res = await vectorizeStore(index as never).query([0.1, 0.2], { topK: 8, filter });
    expect(res).toEqual([{ id: "a", score: 0.9 }, { id: "b", score: 0.5 }]);
    expect(log.query!.options).toEqual({ topK: 8, filter, returnMetadata: "none", returnValues: false });
  });
});

describe("retrievalDeps", () => {
  it("returns only what the environment provides", () => {
    expect(retrievalDeps({} as never)).toEqual({ embedder: undefined, vectors: undefined });
    const both = retrievalDeps({ AI: { run: async () => ({}) }, VECTORIZE: {} } as never);
    expect(both.embedder).toBeDefined();
    expect(both.vectors).toBeDefined();
  });
});
