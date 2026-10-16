import type { Role } from "./access/policy";

/** Bindings and secrets available to the Worker. */
export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  /** Optional until the Workers AI binding is added; code that needs it must handle its absence. */
  AI?: Ai;
  /** Optional until the Vectorize index is created. */
  VECTORIZE?: VectorizeIndex;
  /** Secret: `wrangler secret put ANTHROPIC_API_KEY` */
  ANTHROPIC_API_KEY: string;
  /** Secret: bearer token for ingestion and eval endpoints used by scripts. */
  OPS_TOKEN: string;
  /** Local only (.dev.vars): "development" relaxes the CSP and the Secure cookie flag. Never set in production. */
  APP_ENV?: string;
}

/** The signed-in user as read from the server-side session. This is the only source of truth for the role. */
export interface SessionUser {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  is_admin: boolean;
}

export type AppEnv = { Bindings: Env; Variables: { user: SessionUser | null } };
