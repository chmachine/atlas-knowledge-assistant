// Usage: OPS_TOKEN=... npm run eval -- --target <url> [--dry] [--only id,id] [--modes vector,agentic] [--notes "text"] [--resume <runId>] [--out EVAL_REPORT.md]
// Runs every case in eval/cases.json in both retrieval modes against a deployed Worker, stores the results in D1 and writes EVAL_REPORT.md.
// --dry prints what would run and the estimated cost, and calls nothing. This costs money: ask the owner before every real run.
// The token is read from the environment and never printed.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { renderReport, summarize, type EvalResultRow, type EvalRunRow } from "../src/worker/eval/report";
import { evalCaseSchema, type EvalCase } from "../src/worker/eval/schema";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const arg = (n: string) => {
  const i = args.indexOf(n);
  return i < 0 ? undefined : args[i + 1];
};

const target = (arg("--target") ?? "").replace(/\/$/, "");
const token = process.env.OPS_TOKEN ?? "";
const dry = flag("--dry");
if (!target || (!dry && !token)) {
  console.error("Usage: OPS_TOKEN=... npm run eval -- --target <url> [--dry] [--only id,id] [--modes vector,agentic] [--notes text] [--resume runId] [--out file]");
  process.exit(2);
}

const all = (JSON.parse(readFileSync("eval/cases.json", "utf8")) as unknown[]).map((c) => evalCaseSchema.parse(c));
const only = arg("--only")?.split(",");
const cases = only ? all.filter((c) => only.includes(c.id)) : all;
const modes = (arg("--modes")?.split(",") ?? ["vector", "agentic"]) as ("vector" | "agentic")[];
const jobs = cases.flatMap((c) => modes.map((mode) => ({ c, mode })));

// Estimate from the first full run (80 answers, 2026-10-15): about $0.019 per answer and about $0.0075 per judgement.
const estimate = jobs.length * (0.019 + 0.008);
console.log(`${cases.length} cases x ${modes.length} mode(s) = ${jobs.length} answers, each graded by the judge. Estimated cost: about $${estimate.toFixed(2)}.`);
if (dry) process.exit(0);

// Retries network errors, 5xx, and the app's own "not_found" (seen for a minute or two after a deploy, while some edge locations still
// run the previous version). Safe for /eval/case because a stored (run, case, mode) is returned instead of being answered again.
const call = async (path: string, init?: { method?: string; body?: unknown }) => {
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined;
    let body: Record<string, any> = {};
    let failure = "";
    try {
      res = await fetch(`${target}/api/ops${path}`, {
        method: init?.method ?? "GET",
        headers: { "content-type": "application/json", "X-KB": "1", authorization: `Bearer ${token}` },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      });
      body = (await res.json().catch(() => ({}))) as Record<string, any>;
      if (res.ok) return body;
      failure = `${path}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`;
    } catch (e) {
      failure = `${path}: ${e instanceof Error ? e.message : String(e)}`; // network error
    }
    const transient = !res || res.status >= 500 || body.error === "not_found";
    if (!transient || attempt >= 3) throw new Error(failure);
    console.warn(`retrying (${attempt}/2): ${failure}`);
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
};

const sha = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
})();
const runId = arg("--resume") ?? ((await call("/eval/run", { method: "POST", body: { git_sha: sha, notes: arg("--notes") } })).id as string);
console.log(`Run ${runId}${arg("--resume") ? " (resumed: finished cases are not repeated)" : ""}`);

let done = 0;
const queue = [...jobs];
async function worker() {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const row = (await call("/eval/case", { method: "POST", body: { runId, case: job.c, mode: job.mode } })) as EvalResultRow & { resumed?: boolean };
    const marks = [row.refusal_correct === 0 ? "REFUSAL" : "", row.citation_correct === 0 ? "CITATION" : "", row.leak_free === 0 ? "LEAK" : "", row.error ? "ERROR" : ""].filter(Boolean);
    console.log(`[${++done}/${jobs.length}] ${job.c.id.padEnd(15)} ${job.mode.padEnd(8)} faithfulness ${row.faithfulness ?? "-"}${row.resumed ? " (already done)" : ""}${marks.length ? `  <-- ${marks.join(" ")}` : ""}`);
  }
}
await Promise.all([worker(), worker(), worker()]);

const { run, results } = (await call(`/eval/runs/${runId}`)) as { run: EvalRunRow; results: EvalResultRow[] };
writeFileSync(arg("--out") ?? "EVAL_REPORT.md", renderReport(run, results, cases as EvalCase[]));
for (const mode of modes) {
  const s = summarize(results.filter((r) => r.mode === mode));
  console.log(`\n${mode}: citation ${s.citation_correct.pass}/${s.citation_correct.total}, refusal ${s.refusal_correct.pass}/${s.refusal_correct.total}, blocked refused ${s.blocked_refused.pass}/${s.blocked_refused.total}, faithfulness ${s.faithfulness_mean?.toFixed(2) ?? "n/a"}, errors ${s.errors}, cost $${s.total_cost_usd.toFixed(3)}`);
}
console.log(`\nReport written to ${arg("--out") ?? "EVAL_REPORT.md"}`);
const blockedMissed = results.filter((r) => r.category === "blocked" && r.refusal_correct !== 1).length;
if (blockedMissed) {
  console.error(`WARNING: ${blockedMissed} blocked-for-role answer(s) were not refused.`);
  process.exit(1);
}
