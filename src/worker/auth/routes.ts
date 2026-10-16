import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { SESSION_COOKIE, SESSION_TTL_HOURS } from "../../config";
import { allowedLabels, isRole } from "../access/policy";
import type { AppEnv } from "../env";
import { hit, hourBucket, overLimit, peek, pruneCounters } from "../governance/limits";
import { ipHashOf } from "../util/ip";
import { DUMMY_HASH, verifyPassword } from "./password";
import { createSession, deleteSession } from "./session";

const DEMO_LOGINS_PER_IP_PER_HOUR = 30;
const FAILED_PASSWORDS_PER_IP_PER_HOUR = 10;

const demoBody = z.object({ username: z.string().min(1).max(40) });
const loginBody = z.object({ username: z.string().min(1).max(40), password: z.string().min(1).max(200) });

export const authRoutes = new Hono<AppEnv>();

const ipHash = (c: Context<AppEnv>) => ipHashOf((n) => c.req.header(n));

function startCookie(c: Context<AppEnv>, token: string, secure: boolean) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_HOURS * 3600,
  });
}

const publicUser = (u: { id: string; username: string; display_name: string; role: string; is_admin: number | boolean }) => ({
  id: u.id,
  username: u.username,
  display_name: u.display_name,
  role: u.role,
  is_admin: u.is_admin === true || u.is_admin === 1,
  sees: allowedLabels(u.role),
});

// Public: the login screen needs the list of one-click demo users.
authRoutes.get("/demo-users", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, username, display_name, role, is_admin FROM users WHERE is_demo = 1 ORDER BY is_admin, rowid",
  ).all<{ id: string; username: string; display_name: string; role: string; is_admin: number }>();
  return c.json({ users: results.filter((u) => isRole(u.role)).map(publicUser) });
});

authRoutes.post("/demo", async (c) => {
  const parsed = demoBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);

  const now = new Date();
  const ip = await ipHash(c);
  if (await overLimit(c.env.DB, `login:${ip}:${hourBucket(now)}`, DEMO_LOGINS_PER_IP_PER_HOUR, now)) {
    return c.json({ error: "too_many_logins" }, 429);
  }
  await pruneCounters(c.env.DB, new Date(now.getTime() - 2 * 86400_000));

  // Only accounts flagged as demo can be entered without a password.
  const user = await c.env.DB.prepare(
    "SELECT id, username, display_name, role, is_admin FROM users WHERE username = ? AND is_demo = 1",
  )
    .bind(parsed.data.username)
    .first<{ id: string; username: string; display_name: string; role: string; is_admin: number }>();
  if (!user || !isRole(user.role)) return c.json({ error: "unknown_user" }, 404);

  const { token } = await createSession(c.env.DB, user.id, ip, now);
  startCookie(c, token, c.env.APP_ENV !== "development");
  return c.json({ user: publicUser(user) });
});

// Password login for real (non-demo) accounts. The public demo has none; this is the production path.
authRoutes.post("/login", async (c) => {
  const parsed = loginBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);

  const now = new Date();
  const ip = await ipHash(c);
  const failKey = `loginfail:${ip}:${hourBucket(now)}`;
  if ((await peek(c.env.DB, failKey)) >= FAILED_PASSWORDS_PER_IP_PER_HOUR) return c.json({ error: "too_many_attempts" }, 429);

  const user = await c.env.DB.prepare(
    "SELECT id, username, display_name, role, is_admin, password_hash FROM users WHERE username = ? AND is_demo = 0",
  )
    .bind(parsed.data.username)
    .first<{ id: string; username: string; display_name: string; role: string; is_admin: number; password_hash: string }>();

  // Always run one full verification so a missing user costs the same time as a wrong password.
  const ok = await verifyPassword(parsed.data.password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok || !isRole(user.role)) {
    await hit(c.env.DB, failKey, now);
    return c.json({ error: "invalid_credentials" }, 401);
  }

  const { token } = await createSession(c.env.DB, user.id, ip, now);
  startCookie(c, token, c.env.APP_ENV !== "development");
  return c.json({ user: publicUser(user) });
});

authRoutes.get("/me", (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  return c.json({ user: publicUser(user) });
});

authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await deleteSession(c.env.DB, token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});
