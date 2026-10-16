// Single place for model IDs, prices, limits and thresholds. Nothing else in the code base hard-codes these.

/** Model that writes answers. Change it here only. */
export const CLAUDE_MODEL = "claude-sonnet-5-5";
/** Model that grades answers in the eval (LLM as judge). A different, stronger model than the one answering, so the answerer does not grade itself. */
export const JUDGE_MODEL = "claude-opus-5-5";

/** Workers AI embedding model: multilingual (100+ languages incl. Polish), 8k-token context. */
export const EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
export const EMBEDDING_DIMENSIONS = 1024;

/** USD per 1M tokens, Anthropic list prices. cacheWrite assumes the standard 1.25x of input (not used yet). */
export const PRICING_USD_PER_MTOK: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

// --- Cost and abuse caps (public demo) ---
// Thinking counts toward max_tokens on Sonnet 5.5 even when its text is not returned, so this is more than the answer needs.
export const MAX_OUTPUT_TOKENS = 3000;
export const AGENT_MAX_STEPS = 6;
export const DAILY_QUESTIONS_PER_USER = 25;
export const DAILY_QUESTIONS_PER_IP = 20;
export const DAILY_QUESTIONS_GLOBAL = 200;
export const MAX_QUESTION_CHARS = 1000;

// --- Retrieval ---
export const VECTOR_TOP_K = 8;
/** Cosine similarity below this is treated as "not relevant" and dropped before the model sees it. */
export const MIN_SIMILARITY = 0.35;

// --- Sessions ---
export const SESSION_TTL_HOURS = 8;
export const SESSION_COOKIE = "kb_session";
/** Every state-changing request must carry this header (CSRF guard). */
export const CSRF_HEADER = "X-KB";

// --- Dashboard ---
/** Editable on the dashboard; this is only the default. */
export const DEFAULT_MINUTES_PER_SEARCH = 6;
