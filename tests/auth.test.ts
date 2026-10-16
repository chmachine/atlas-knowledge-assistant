import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requireAdmin, requireUser, loadSession } from "../src/worker/auth/middleware";
import { hashPassword } from "../src/worker/auth/password";
import { createSession, userForToken } from "../src/worker/auth/session";
import type { AppEnv } from "../src/worker/env";
import { sha256Hex } from "../src/worker/util/crypto";
import { call, cookieFrom, loginAs, makeEnv } from "./helpers";

describe("demo users", () => {
  it("lists the five demo users with what each may see, and no secrets", async () => {
    const env = makeEnv();
    const res = await call(env, "GET", "/api/auth/demo-users");
    expect(res.status).toBe(200);
    const { users } = (await res.json()) as { users: Record<string, unknown>[] };
    expect(users.map((u) => u.username)).toEqual(["employee", "it_ops", "hr", "finance", "admin"]);
    const sees = Object.fromEntries(users.map((u) => [u.username, u.sees]));
    expect(sees).toEqual({
      employee: ["general"],
      it_ops: ["general", "it", "security"],
      hr: ["general", "hr"],
      finance: ["general", "finance"],
      admin: ["general"],
    });
    expect(JSON.stringify(users)).not.toMatch(/password|hash/i);
  });

  it("the admin is an employee for documents: admin rights do not widen document access", async () => {
    const env = makeEnv();
    const row = await env.DB.prepare("SELECT role, is_admin FROM users WHERE username = 'admin'").first<{ role: string; is_admin: number }>();
    expect(row).toEqual({ role: "employee", is_admin: 1 });
  });
});

describe("demo login", () => {
  it("logs in as hr and sets a hardened cookie", async () => {
    const env = makeEnv();
    const res = await call(env, "POST", "/api/auth/demo", { body: { username: "hr" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { role: string; sees: string[]; is_admin: boolean } };
    expect(body.user).toMatchObject({ role: "hr", sees: ["general", "hr"], is_admin: false });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^kb_session=[A-Za-z0-9_-]{40,}/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=28800");
  });

  it("drops the Secure flag only in local development", async () => {
    const env = makeEnv({ APP_ENV: "development" });
    const res = await call(env, "POST", "/api/auth/demo", { body: { username: "hr" } });
    expect(res.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("stores only the hash of the token, never the token", async () => {
    const env = makeEnv();
    const cookie = await loginAs(env, "hr");
    const token = cookie.split("=")[1]!;
    const rows = (await env.DB.prepare("SELECT id FROM sessions").all<{ id: string }>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(await sha256Hex(token));
    expect(rows[0]!.id).not.toBe(token);
  });

  it("takes the role from the user record, ignoring any role in the request", async () => {
    const env = makeEnv();
    const res = await call(env, "POST", "/api/auth/demo", { body: { username: "employee", role: "hr", is_admin: true } });
    const body = (await res.json()) as { user: { role: string; is_admin: boolean } };
    expect(body.user).toMatchObject({ role: "employee", is_admin: false });
    const me = await call(env, "GET", "/api/auth/me", { cookie: cookieFrom(res) });
    expect(((await me.json()) as { user: { role: string } }).user.role).toBe("employee");
  });

  it("rejects unknown users, bad bodies and a missing CSRF header", async () => {
    const env = makeEnv();
    expect((await call(env, "POST", "/api/auth/demo", { body: { username: "nobody" } })).status).toBe(404);
    expect((await call(env, "POST", "/api/auth/demo", { body: {} })).status).toBe(400);
    expect((await call(env, "POST", "/api/auth/demo", { body: "not json" as never })).status).toBe(400);
    const noHeader = await call(env, "POST", "/api/auth/demo", { body: { username: "hr" }, headers: { "X-KB": "" } });
    expect(noHeader.status).toBe(403);
    expect(await noHeader.json()).toEqual({ error: "csrf_header_required" });
  });

  it("refuses to demo-login a real (password) account", async () => {
    const env = makeEnv();
    await env.DB.prepare("INSERT INTO users (id, username, display_name, role, is_demo, password_hash) VALUES (?, ?, ?, ?, 0, ?)")
      .bind("u_real", "real", "Real Person", "hr", await hashPassword("pw-123456"))
      .run();
    expect((await call(env, "POST", "/api/auth/demo", { body: { username: "real" } })).status).toBe(404);
  });

  it("limits demo logins per IP per hour, independently per IP", async () => {
    const env = makeEnv();
    for (let i = 0; i < 30; i++) expect((await call(env, "POST", "/api/auth/demo", { body: { username: "hr" }, ip: "9.9.9.9" })).status).toBe(200);
    expect((await call(env, "POST", "/api/auth/demo", { body: { username: "hr" }, ip: "9.9.9.9" })).status).toBe(429);
    expect((await call(env, "POST", "/api/auth/demo", { body: { username: "hr" }, ip: "8.8.8.8" })).status).toBe(200);
  });

  it("does not store the raw IP address", async () => {
    const env = makeEnv();
    await loginAs(env, "hr", "203.0.113.7");
    const dump = JSON.stringify(env.DB.raw.prepare("SELECT * FROM sessions").all()) + JSON.stringify(env.DB.raw.prepare("SELECT * FROM rate_counters").all());
    expect(dump).not.toContain("203.0.113.7");
  });
});

describe("session lifecycle", () => {
  it("/me returns the user with a valid cookie and 401 without or with garbage", async () => {
    const env = makeEnv();
    const cookie = await loginAs(env, "finance");
    const ok = await call(env, "GET", "/api/auth/me", { cookie });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { user: { username: string } }).user.username).toBe("finance");
    expect((await call(env, "GET", "/api/auth/me")).status).toBe(401);
    expect((await call(env, "GET", "/api/auth/me", { cookie: "kb_session=garbage" })).status).toBe(401);
  });

  it("logout deletes the server-side session, so the old cookie stops working", async () => {
    const env = makeEnv();
    const cookie = await loginAs(env, "hr");
    const out = await call(env, "POST", "/api/auth/logout", { cookie });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/kb_session=;|Max-Age=0|Expires=/);
    expect((await call(env, "GET", "/api/auth/me", { cookie })).status).toBe(401);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(0);
  });

  it("an expired session is rejected and cleaned up on the next login", async () => {
    const env = makeEnv();
    const longAgo = new Date(Date.now() - 9 * 3600_000); // sessions last 8 h
    const { token } = await createSession(env.DB, "u_hr", null, longAgo);
    expect(await userForToken(env.DB, token)).toBeNull();
    expect(await userForToken(env.DB, token, longAgo)).toMatchObject({ username: "hr", role: "hr" });
    await loginAs(env, "employee");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(1);
  });

  it("rejects oversized request bodies", async () => {
    const env = makeEnv();
    const res = await call(env, "POST", "/api/auth/demo", { body: { username: "x".repeat(20_000) } });
    expect(res.status).toBe(413);
  });
});

describe("password login (real accounts)", () => {
  async function envWithUser() {
    const env = makeEnv();
    await env.DB.prepare("INSERT INTO users (id, username, display_name, role, is_demo, password_hash) VALUES (?, ?, ?, ?, 0, ?)")
      .bind("u_real", "real", "Real Person", "finance", await hashPassword("pw-123456"))
      .run();
    return env;
  }

  it("accepts the right password and rejects wrong, unknown and demo accounts the same way", async () => {
    const env = await envWithUser();
    const good = await call(env, "POST", "/api/auth/login", { body: { username: "real", password: "pw-123456" } });
    expect(good.status).toBe(200);
    expect(((await good.json()) as { user: { role: string } }).user.role).toBe("finance");
    for (const body of [
      { username: "real", password: "wrong" },
      { username: "ghost", password: "pw-123456" },
      { username: "hr", password: "anything" }, // a demo account has no password and cannot be entered this way
    ]) {
      const res = await call(env, "POST", "/api/auth/login", { body });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_credentials" });
    }
  });

  it("locks out an IP after 10 failed attempts in an hour", async () => {
    const env = await envWithUser();
    for (let i = 0; i < 10; i++) {
      expect((await call(env, "POST", "/api/auth/login", { body: { username: "real", password: "nope" }, ip: "7.7.7.7" })).status).toBe(401);
    }
    const blocked = await call(env, "POST", "/api/auth/login", { body: { username: "real", password: "pw-123456" }, ip: "7.7.7.7" });
    expect(blocked.status).toBe(429);
  });

  it("the database refuses a demo user with a password and a real user without one", async () => {
    const env = makeEnv();
    const insert = (demo: number, hash: string | null) =>
      env.DB.prepare("INSERT INTO users (id, username, display_name, role, is_demo, password_hash) VALUES ('x', 'x', 'X', 'hr', ?, ?)").bind(demo, hash).run();
    await expect(insert(1, "something")).rejects.toThrow();
    await expect(insert(0, null)).rejects.toThrow();
  });
});

describe("requireUser / requireAdmin", () => {
  const guarded = new Hono<AppEnv>();
  guarded.use("*", loadSession);
  guarded.get("/user", requireUser, (c) => c.json({ ok: true }));
  guarded.get("/admin", requireAdmin, (c) => c.json({ ok: true }));
  const get = async (env: ReturnType<typeof makeEnv>, path: string, cookie?: string) =>
    (await guarded.request(path, { headers: cookie ? { cookie } : {} }, env as never)).status;

  it("anonymous: 401 on both", async () => {
    const env = makeEnv();
    expect(await get(env, "/user")).toBe(401);
    expect(await get(env, "/admin")).toBe(401);
  });

  it("a normal user passes requireUser but gets 403 on admin routes", async () => {
    const env = makeEnv();
    for (const name of ["employee", "it_ops", "hr", "finance"]) {
      const cookie = await loginAs(env, name);
      expect(await get(env, "/user", cookie)).toBe(200);
      expect(await get(env, "/admin", cookie)).toBe(403);
    }
  });

  it("the admin passes both", async () => {
    const env = makeEnv();
    const cookie = await loginAs(env, "admin");
    expect(await get(env, "/user", cookie)).toBe(200);
    expect(await get(env, "/admin", cookie)).toBe(200);
  });
});
