import { EMBEDDING_DIMENSIONS } from "../src/config";
import type { Embedder, VectorMatch, VectorRecord, VectorStore } from "../src/worker/retrieval/ports";

const fold = (s: string) => s.toLowerCase().replace(/[ąćęłńóśźż]/g, (c) => ({ ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z" })[c] ?? c);

/** Deterministic bag-of-words embedding: hashes the first 4 letters of each word into 1024 buckets and normalises. Good enough to rank. */
export function hashEmbed(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of fold(text).match(/[a-z0-9]{3,}/g) ?? []) {
    const stem = word.slice(0, 4);
    let h = 2166136261;
    for (const ch of stem) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    v[h % EMBEDDING_DIMENSIONS]! += 1;
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export class FakeEmbedder implements Embedder {
  /** Every text ever passed in, so tests can inspect exactly what would have left the Worker. */
  seen: string[] = [];
  calls = 0;
  failNext = false;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    if (this.failNext) {
      this.failNext = false;
      throw new Error("embedder down");
    }
    this.seen.push(...texts);
    return texts.map(hashEmbed);
  }
}

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

/** In-memory Vectorize stand-in that applies the metadata filter the way Vectorize does ($eq and $in). */
export class FakeVectorStore implements VectorStore {
  records = new Map<string, VectorRecord>();
  upserts = 0;
  lastFilter: Record<string, unknown> | null = null;
  queries = 0;

  async upsert(records: VectorRecord[]) {
    this.upserts += records.length;
    for (const r of records) this.records.set(r.id, r);
  }
  async deleteByIds(ids: string[]) {
    for (const id of ids) this.records.delete(id);
  }
  protected matches(r: VectorRecord, filter: Record<string, unknown>): boolean {
    return Object.entries(filter).every(([key, cond]) => {
      const actual = (r.metadata as Record<string, unknown>)[key];
      if (cond && typeof cond === "object" && "$in" in cond) return ((cond as { $in: unknown[] }).$in).includes(actual);
      if (cond && typeof cond === "object" && "$eq" in cond) return (cond as { $eq: unknown }).$eq === actual;
      return actual === cond;
    });
  }
  async query(vector: number[], opts: { topK: number; filter: Record<string, unknown> }): Promise<VectorMatch[]> {
    this.queries++;
    this.lastFilter = opts.filter;
    return [...this.records.values()]
      .filter((r) => this.matches(r, opts.filter))
      .map((r) => ({ id: r.id, score: cosine(vector, r.values) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.topK);
  }
}

/** A faulty store that ignores the filter and returns everything: used to prove the SQL re-check is a real second line of defence. */
export class LeakyVectorStore extends FakeVectorStore {
  protected override matches(): boolean {
    return true;
  }
}

// ---- A scripted model ------------------------------------------------------------------------------------------------------------
import type { JsonBlock, Llm, LlmRequest, LlmResponse } from "../src/worker/answer/llm";

export interface SeenResult {
  index: number;
  source: string;
  title: string;
  info: string;
  text: string;
  citationsEnabled: boolean;
}

/** Every search_result block in the conversation, in request order (the order the API counts citation indexes in), including those inside tool results. */
export function seenResults(req: LlmRequest): SeenResult[] {
  const out: SeenResult[] = [];
  for (const m of req.messages) {
    const content = Array.isArray(m.content) ? m.content : [];
    for (const top of content) {
      const blocks = top.type === "tool_result" && Array.isArray(top.content) ? (top.content as JsonBlock[]) : [top];
      for (const b of blocks) {
        if (b.type !== "search_result") continue;
        const parts = (b.content as { text: string }[]) ?? [];
        out.push({ index: out.length, source: String(b.source), title: String(b.title), info: parts[0]?.text ?? "", text: parts[1]?.text ?? "", citationsEnabled: (b.citations as { enabled?: boolean } | undefined)?.enabled === true });
      }
    }
  }
  return out;
}

export const questionOf = (req: LlmRequest): string => {
  const last = req.messages[req.messages.length - 1]!;
  const content = Array.isArray(last.content) ? last.content : [];
  return String(content.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
};

/** A text block citing the first search result whose source matches, the way the real API returns citations. */
export function cite(req: LlmRequest, match: (source: string) => boolean, text: string): JsonBlock {
  const found = seenResults(req).find((r) => match(r.source));
  if (!found) throw new Error("test script: no matching source was given to the model");
  return { type: "text", text, citations: [{ type: "search_result_location", search_result_index: found.index, source: found.source, title: found.title, cited_text: found.text.slice(0, 80), start_block_index: 1, end_block_index: 2 }] };
}

export class ScriptedLlm implements Llm {
  /** Snapshots taken at call time: the agent loop keeps appending to the same messages array afterwards. */
  requests: LlmRequest[] = [];
  constructor(private script: (req: LlmRequest) => Partial<LlmResponse> & { content: JsonBlock[] }) {}
  async create(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(JSON.parse(JSON.stringify(req)) as LlmRequest);
    return {
      stopReason: "end_turn",
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: "claude-sonnet-5-5",
      fellBack: false,
      ...this.script(req),
    };
  }
}

export const firstQuestion = (req: LlmRequest): string => {
  const first = req.messages[0]!;
  const content = Array.isArray(first.content) ? first.content : [];
  return String(content.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
};

export const toolUse = (id: string, name: string, input: unknown): JsonBlock => ({ type: "tool_use", id, name, input });
