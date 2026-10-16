import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { CSRF_HEADER, SESSION_COOKIE } from "../../config";
import type { AppEnv } from "../env";
import { userForToken } from "./session";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Every state-changing request must carry the custom header. Browsers cannot add it cross-site without a CORS preflight. */
export const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method) && c.req.header(CSRF_HEADER) !== "1") {
    return c.json({ error: "csrf_header_required" }, 403);
  }
  await next();
};

/** Puts the user (or null) on the context. Touches the database only when a cookie is present. */
export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  c.set("user", token ? await userForToken(c.env.DB, token) : null);
  await next();
};

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("user")) return c.json({ error: "unauthenticated" }, 401);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  if (!user.is_admin) return c.json({ error: "forbidden" }, 403);
  await next();
};
