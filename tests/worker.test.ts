import { describe, expect, it } from "vitest";
import app from "../src/worker/index";
import { SECURITY_HEADERS } from "../src/worker/security";

const assets = {
  fetch: async () =>
    // An immutable-headers response, like the one the real ASSETS binding returns.
    Response.redirect("https://example.test/", 302),
};
const baseEnv: Record<string, unknown> = { ASSETS: assets };
const env = baseEnv as never;

describe("worker shell", () => {
  it("serves /api/health", async () => {
    const res = await app.request("/api/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "kb-assistant" });
  });

  it("adds noindex and security headers to API responses", async () => {
    const res = await app.request("/api/health", {}, env);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(name)).toBe(value);
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
  });

  it("adds the same headers to static asset responses", async () => {
    const res = await app.request("/some/page", {}, env);
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it("drops only the CSP when APP_ENV=development, and keeps noindex", async () => {
    const res = await app.request("/api/health", {}, { ...baseEnv, APP_ENV: "development" } as never);
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
  });

  it("keeps the strict CSP for any other APP_ENV value", async () => {
    const res = await app.request("/api/health", {}, { ...baseEnv, APP_ENV: "production" } as never);
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
  });

  it("returns 404 JSON for unknown API paths instead of the SPA", async () => {
    const res = await app.request("/api/nope", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
