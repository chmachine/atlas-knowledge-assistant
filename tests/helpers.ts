import defaultApp from "../src/worker/index";
import { makeDb, type TestDb } from "./d1";

export interface TestEnv {
  DB: TestDb;
  ASSETS: { fetch: () => Promise<Response> };
  APP_ENV?: string;
  [key: string]: unknown;
}

export function makeEnv(extra: Record<string, unknown> = {}): TestEnv {
  return { DB: makeDb(), ASSETS: { fetch: async () => new Response("spa") }, ...extra };
}

type Init = { cookie?: string; ip?: string; headers?: Record<string, string>; body?: unknown; app?: { request: (path: string, init: RequestInit, env: never) => Response | Promise<Response> } };

/** Calls the real Worker app. State-changing methods get the CSRF header unless `headers` overrides it. */
export function call(env: TestEnv, method: string, path: string, init: Init = {}): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": init.ip ?? "10.0.0.1" };
  if (method !== "GET") headers["X-KB"] = "1";
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.cookie) headers.cookie = init.cookie;
  Object.assign(headers, init.headers);
  return Promise.resolve(
    (init.app ?? defaultApp).request(path, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }, env as never),
  );
}

export const cookieFrom = (res: Response): string => {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
};

/** Logs in as a demo user and returns the Cookie header value for later calls. */
export async function loginAs(env: TestEnv, username: string, ip = "10.0.0.1"): Promise<string> {
  const res = await call(env, "POST", "/api/auth/demo", { body: { username }, ip });
  if (res.status !== 200) throw new Error(`demo login as ${username} failed: ${res.status}`);
  return cookieFrom(res);
}
