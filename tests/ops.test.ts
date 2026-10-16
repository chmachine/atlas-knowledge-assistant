import { describe, expect, it } from "vitest";
import { loadCorpus } from "../scripts/check-corpus";
import { EMBEDDING_DIMENSIONS } from "../src/config";
import { call, loginAs, makeEnv } from "./helpers";
import { hashEmbed } from "./fakes";

const TOKEN = "test-ops-token-0123456789";
const raw = loadCorpus().find((f) => f.path.endsWith("/hr-sick-leave.md"))!.raw;
const ops = (env: ReturnType<typeof makeEnv>, method: string, path: string, body?: unknown, auth: string | null = `Bearer ${TOKEN}`) =>
  call(env, method, path, { body, headers: auth ? { authorization: auth } : {} });

function fakeCloudflare() {
  const upserts: unknown[][] = [];
  const AI = { run: async (_m: string, input: { text: string[] }) => ({ shape: [input.text.length, EMBEDDING_DIMENSIONS], data: input.text.map(hashEmbed) }) };
  const VECTORIZE = { upsert: async (v: unknown[]) => void upserts.push(v), deleteByIds: async () => undefined, query: async () => ({ matches: [], count: 0 }) };
  return { AI, VECTORIZE, upserts };
}

describe("ops endpoints: who may call them", () => {
  it("are off when no OPS_TOKEN is configured (fail closed, even for the right-looking header)", async () => {
    const env = makeEnv();
    expect((await ops(env, "POST", "/api/ops/ingest", { raw })).status).toBe(503);
    expect((await ops(env, "GET", "/api/ops/status")).status).toBe(503);
    expect((await ops(env, "GET", "/api/ops/status", undefined, "Bearer ")).status).toBe(503);
  });

  it("reject a missing, malformed or wrong token", async () => {
    const env = makeEnv({ OPS_TOKEN: TOKEN });
    for (const auth of [null, "", "Bearer", "Bearer wrong", `bearer ${TOKEN}`, TOKEN, `Basic ${TOKEN}`, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`]) {
      expect((await ops(env, "GET", "/api/ops/status", undefined, auth)).status, String(auth)).toBe(401);
    }
  });

  it("are not opened by a signed-in session, not even the admin's", async () => {
    const env = makeEnv({ OPS_TOKEN: TOKEN });
    const cookie = await loginAs(env, "admin");
    expect((await call(env, "GET", "/api/ops/status", { cookie })).status).toBe(401);
    expect((await call(env, "POST", "/api/ops/ingest", { cookie, body: { raw } })).status).toBe(401);
  });

  it("still need the CSRF header on writes", async () => {
    const env = makeEnv({ OPS_TOKEN: TOKEN });
    const res = await call(env, "POST", "/api/ops/ingest", { body: { raw }, headers: { authorization: `Bearer ${TOKEN}`, "X-KB": "" } });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/ops/ingest", () => {
  it("indexes a document for full-text search when vectors:false, with no cloud bindings at all", async () => {
    const env = makeEnv({ OPS_TOKEN: TOKEN });
    const res = await ops(env, "POST", "/api/ops/ingest", { raw, vectors: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "hr-sick-leave", status: "created", vectors: 0, flagged: 0 });
    const status = (await (await ops(env, "GET", "/api/ops/status")).json()) as Record<string, unknown>;
    expect(status).toMatchObject({ documents: 1, embedded: 0, bindings: { ai: false, vectorize: false } });
  });

  it("explains itself instead of pretending when vectors are wanted but the bindings are missing", async () => {
    const env = makeEnv({ OPS_TOKEN: TOKEN });
    const res = await ops(env, "POST", "/api/ops/ingest", { raw });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "vector_search_not_configured" });
    expect(((await (await ops(env, "GET", "/api/ops/status")).json()) as { documents: number }).documents).toBe(0);
  });

  it("writes vectors through the Workers AI and Vectorize bindings when they exist", async () => {
    const cf = fakeCloudflare();
    const env = makeEnv({ OPS_TOKEN: TOKEN, AI: cf.AI, VECTORIZE: cf.VECTORIZE });
    const res = await ops(env, "POST", "/api/ops/ingest", { raw });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vectors: number; chunks: number };
    expect(body.vectors).toBe(body.chunks);
    expect(cf.upserts.flat().length).toBe(body.chunks);
    expect(((await (await ops(env, "GET", "/api/ops/status")).json()) as { embedded: number }).embedded).toBe(1);
  });

  it("answers an unchanged document with status 'unchanged' and force re-indexes it", async () => {
    const env = makeEnv({ OPS_TOKEN: TOKEN });
    await ops(env, "POST", "/api/ops/ingest", { raw, vectors: false });
    expect(((await (await ops(env, "POST", "/api/ops/ingest", { raw, vectors: false })).json()) as { status: string }).status).toBe("unchanged");
    expect(((await (await ops(env, "POST", "/api/ops/ingest", { raw, vectors: false, force: true })).json()) as { status: string }).status).toBe("updated");
  });

  it("returns 400 for bad documents and bad bodies, 413 for too large ones", async () => {
    const env = makeEnv({ OPS_TOKEN: TOKEN });
    const bad = await ops(env, "POST", "/api/ops/ingest", { raw: "# no front matter", vectors: false });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_document" });
    expect((await ops(env, "POST", "/api/ops/ingest", { nothing: true })).status).toBe(400);
    expect((await ops(env, "POST", "/api/ops/ingest", { raw: "x".repeat(300_000) })).status).toBe(413);
  });

  it("ordinary API routes keep their small body limit", async () => {
    const env = makeEnv({ OPS_TOKEN: TOKEN });
    expect((await call(env, "POST", "/api/auth/demo", { body: { username: "x".repeat(20_000) } })).status).toBe(413);
  });
});
