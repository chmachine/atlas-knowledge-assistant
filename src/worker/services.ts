import { JUDGE_MODEL } from "../config";
import { anthropicLlm, type Llm } from "./answer/llm";
import type { Env } from "./env";
import { retrievalDeps } from "./retrieval/adapters";
import type { Embedder, VectorStore } from "./retrieval/ports";

/** The outside services the app talks to. Each is undefined when it is not configured. Tests inject fakes through `createApp`. */
export interface Services {
  llm?: Llm;
  /** The model that grades answers in the eval. */
  judge?: Llm;
  embedder?: Embedder;
  vectors?: VectorStore;
}
export type ServicesFactory = (env: Env) => Services;

export const defaultServices: ServicesFactory = (env) => ({
  ...retrievalDeps(env),
  llm: env.ANTHROPIC_API_KEY ? anthropicLlm(env.ANTHROPIC_API_KEY) : undefined,
  judge: env.ANTHROPIC_API_KEY ? anthropicLlm(env.ANTHROPIC_API_KEY, { model: JUDGE_MODEL }) : undefined,
});
