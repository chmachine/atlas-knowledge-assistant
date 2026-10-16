// Usage: OPS_TOKEN=... npm run probe -- --target https://kb-assistant.<subdomain>.workers.dev
// Measures vector retrieval alone (no model call, no cost beyond embeddings) on eval/probe.json and shows where the similarity threshold
// should sit. The token is read from the environment and never printed.
import { readFileSync } from "node:fs";

interface Case { id: string; role: string; question: string; expect: string[] | null; note?: string }
interface Hit { id: string; score: number; doc_id: string; section: string }

const args = process.argv.slice(2);
const targetAt = args.indexOf("--target");
const target = (targetAt < 0 ? "" : args[targetAt + 1] ?? "").replace(/\/$/, "");
const token = process.env.OPS_TOKEN ?? "";
if (!target || !token) {
  console.error("Usage: OPS_TOKEN=... npm run probe -- --target <url>");
  process.exit(2);
}

const cases = JSON.parse(readFileSync("eval/probe.json", "utf8")) as Case[];
const answerable: { id: string; rank: number | null; best: number; top: number }[] = [];
const unanswerable: { id: string; top: number; topDoc: string }[] = [];
let dropped = 0;

for (const c of cases) {
  const res = await fetch(`${target}/api/ops/retrieve`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-KB": "1", authorization: `Bearer ${token}` },
    body: JSON.stringify({ role: c.role, question: c.question, topK: 12 }),
  });
  if (!res.ok) {
    console.error(`FAIL ${c.id}: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const body = (await res.json()) as { results: Hit[]; dropped: number };
  dropped += body.dropped;
  const top = body.results[0];
  if (c.expect) {
    const idx = body.results.findIndex((r) => c.expect!.includes(r.doc_id));
    const best = idx >= 0 ? body.results[idx]!.score : 0;
    answerable.push({ id: c.id, rank: idx >= 0 ? idx + 1 : null, best, top: top?.score ?? 0 });
    console.log(`${c.id.padEnd(14)} ${c.role.padEnd(8)} expected ${c.expect[0]!.padEnd(24)} rank ${String(idx >= 0 ? idx + 1 : "-").padStart(2)}  score ${best.toFixed(3)}  top ${top ? `${top.doc_id} ${top.score.toFixed(3)}` : "-"}`);
  } else {
    unanswerable.push({ id: c.id, top: top?.score ?? 0, topDoc: top?.doc_id ?? "-" });
    console.log(`${c.id.padEnd(14)} ${c.role.padEnd(8)} NO ANSWER (${c.note})`.padEnd(66) + ` top ${top ? `${top.doc_id} ${top.score.toFixed(3)}` : "-"}`);
  }
}

const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(0)}%`;
const hits = (k: number) => answerable.filter((a) => a.rank !== null && a.rank <= k).length;
console.log(`\nDocument hit rate over ${answerable.length} answerable questions: top1 ${pct(hits(1), answerable.length)}, top3 ${pct(hits(3), answerable.length)}, top12 ${pct(hits(12), answerable.length)}`);
console.log(`Matches removed by the SQL permission re-check: ${dropped} (must be 0 with a correct vector filter)`);
console.log(`\nScores of the right document: min ${Math.min(...answerable.map((a) => a.best)).toFixed(3)}, median ${[...answerable.map((a) => a.best)].sort((a, b) => a - b)[Math.floor(answerable.length / 2)]!.toFixed(3)}`);
console.log(`Best score for questions with no answer: min ${Math.min(...unanswerable.map((a) => a.top)).toFixed(3)}, max ${Math.max(...unanswerable.map((a) => a.top)).toFixed(3)}`);
console.log("\nthreshold  answerable kept   no-answer still passing");
for (let t = 0.2; t <= 0.8001; t += 0.05) {
  const kept = answerable.filter((a) => a.best >= t).length;
  const passing = unanswerable.filter((a) => a.top >= t).length;
  console.log(`  ${t.toFixed(2)}      ${pct(kept, answerable.length).padStart(4)}  (${kept}/${answerable.length})     ${pct(passing, unanswerable.length).padStart(4)}  (${passing}/${unanswerable.length})`);
}
