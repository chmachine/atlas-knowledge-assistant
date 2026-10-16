// Usage:
//   OPS_TOKEN=... npm run ingest -- --target https://<worker>.workers.dev
//   npm run ingest -- --local                 # http://localhost:5173, token read from .dev.vars, full-text index only
// Flags: --target <url>  --local  --no-vectors  --force  --no-wait
// With vectors, the script waits at the end until filtered vector queries return results for every role: Vectorize indexes
// asynchronously, and right after the vector count reaches the total, filtered queries can still come back empty for a few minutes.
// The token is never printed. Set it as an environment variable or in .dev.vars; never paste it into a chat.
import { existsSync, readFileSync } from "node:fs";
import { loadCorpus } from "./check-corpus";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => args[args.indexOf(name) + 1];

const local = flag("--local");
const target = (local ? "http://localhost:5173" : value("--target") ?? "").replace(/\/$/, "");
if (!target) {
  console.error("Missing --target <url> (or use --local).");
  process.exit(2);
}

let token = process.env.OPS_TOKEN ?? "";
if (!token && local && existsSync(".dev.vars")) {
  token = /^OPS_TOKEN=(.+)$/m.exec(readFileSync(".dev.vars", "utf8"))?.[1]?.trim() ?? "";
}
if (!token) {
  console.error("OPS_TOKEN is not set (environment variable, or .dev.vars with --local).");
  process.exit(2);
}

const vectors = !(flag("--no-vectors") || local);
const files = loadCorpus();
let failed = 0;
const totals = { created: 0, updated: 0, unchanged: 0, chunks: 0, vectors: 0, flagged: 0, redacted: 0 };

for (const file of files) {
  const res = await fetch(`${target}/api/ops/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-KB": "1", authorization: `Bearer ${token}` },
    body: JSON.stringify({ raw: file.raw, vectors, force: flag("--force") }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    failed++;
    console.error(`FAIL ${file.path}: ${res.status} ${JSON.stringify(body)}`);
    continue;
  }
  const status = body.status as "created" | "updated" | "unchanged";
  totals[status]++;
  totals.chunks += Number(body.chunks);
  totals.vectors += Number(body.vectors);
  totals.flagged += Number(body.flagged);
  totals.redacted += Number(body.redacted);
  console.log(`${status.padEnd(9)} ${file.path} (${body.chunks} chunks${vectors ? `, ${body.vectors} vectors` : ""}${Number(body.flagged) ? `, ${body.flagged} flagged` : ""})`);
}

// Readiness: a filtered query per role must return results in two consecutive rounds.
async function waitUntilReady() {
  const probes: [string, string][] = [["employee", "praca zdalna dni w tygodniu"], ["hr", "urlop na żądanie"], ["finance", "limit hotelu delegacja"], ["it_ops", "certyfikat VPN błąd"]];
  const started = Date.now();
  let okRounds = 0;
  while (Date.now() - started < 8 * 60_000) {
    let ready = true;
    for (const [role, question] of probes) {
      const res = await fetch(`${target}/api/ops/retrieve`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-KB": "1", authorization: `Bearer ${token}` },
        body: JSON.stringify({ role, question, topK: 3 }),
      });
      const body = (await res.json().catch(() => ({}))) as { results?: unknown[] };
      if (!res.ok || !body.results?.length) ready = false;
    }
    okRounds = ready ? okRounds + 1 : 0;
    if (okRounds >= 2) return console.log(`Vector index ready for filtered queries after ${Math.round((Date.now() - started) / 1000)} s.`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.error("Warning: the vector index did not become ready within 8 minutes; filtered queries may still return empty lists.");
}
if (vectors && !failed && !flag("--no-wait")) {
  console.log("\nWaiting for the vector index to be ready for filtered queries…");
  await waitUntilReady();
}

console.log(`\n${files.length - failed}/${files.length} documents ok: ${totals.created} created, ${totals.updated} updated, ${totals.unchanged} unchanged; ${totals.chunks} chunks, ${totals.vectors} vectors, ${totals.flagged} flagged as suspicious, ${totals.redacted} personal-data items redacted before embedding.`);
process.exit(failed ? 1 : 0);
