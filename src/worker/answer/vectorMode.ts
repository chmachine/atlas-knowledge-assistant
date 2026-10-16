import { MAX_OUTPUT_TOKENS } from "../../config";
import type { Embedder, VectorStore } from "../retrieval/ports";
import { getDocTitles } from "../retrieval/store";
import { retrieveVector } from "../retrieval/vector";
import type { Llm, LlmResponse } from "./llm";
import { SYSTEM_PROMPT, buildSearchResults } from "./prompts";
import { RunError, type ModelRun } from "./run";

/** Vector mode: retrieve first, then one model call with the passages attached. The question must already be redacted. */
export async function runVector(
  deps: { db: D1Database; llm: Llm; embedder: Embedder; vectors: VectorStore; minSimilarity?: number },
  role: string,
  question: string,
): Promise<ModelRun> {
  let retrieval;
  try {
    // The role comes from the session. Retrieval filters by it before anything is returned.
    retrieval = await retrieveVector({ db: deps.db, embedder: deps.embedder, vectors: deps.vectors }, role, question, { minSimilarity: deps.minSimilarity });
  } catch (e) {
    throw new RunError("retrieval", (e as Error).message);
  }

  const referenced = retrieval.chunks.flatMap((c) => [c.supersedes, c.superseded_by].filter((x): x is string => Boolean(x)));
  const titles = await getDocTitles(deps.db, role, referenced);
  const { blocks, redactions } = buildSearchResults(retrieval.chunks, (id) => titles.get(id));

  let res: LlmResponse;
  try {
    res = await deps.llm.create({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: [...blocks, { type: "text", text: question }] }],
      maxTokens: MAX_OUTPUT_TOKENS,
      effort: "low",
    });
  } catch (e) {
    throw new RunError("model", (e as Error).message, retrieval.relevantIds);
  }

  return {
    content: res.content,
    stopReason: res.stopReason,
    usage: res.usage,
    model: res.model,
    fellBack: res.fellBack,
    given: retrieval.chunks,
    relevantIds: retrieval.relevantIds,
    toolCalls: [{ step: 1, tool: "vector_search", input: question, found: retrieval.relevantIds.length, chunkIds: retrieval.relevantIds }],
    redactions: Object.values(redactions).reduce((a, b) => a + b, 0),
    steps: 1,
  };
}
