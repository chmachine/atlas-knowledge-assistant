// Usage: OPS_TOKEN=... npm run try -- --target <url> --role hr --mode vector|agentic --question "..." [--min 0.4]
// Asks one question as the given role through the ops endpoint (an eval run: no daily limits, not shown on the dashboard).
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1]; // an absent flag is undefined, never the first argument
};
const target = (arg("--target") ?? "").replace(/\/$/, "");
const token = process.env.OPS_TOKEN ?? "";
const [role, mode, question] = [arg("--role"), arg("--mode") ?? "vector", arg("--question")];
if (!target || !token || !role || !question) {
  console.error('Usage: OPS_TOKEN=... npm run try -- --target <url> --role hr --mode vector --question "..." [--min 0.4]');
  process.exit(2);
}
const min = arg("--min");
const res = await fetch(`${target}/api/ops/ask`, {
  method: "POST",
  headers: { "content-type": "application/json", "X-KB": "1", authorization: `Bearer ${token}` },
  body: JSON.stringify({ role, question, mode, ...(min ? { minSimilarity: Number(min) } : {}) }),
});
const body = (await res.json()) as Record<string, any>;
if (!res.ok) {
  console.error(`HTTP ${res.status}`, JSON.stringify(body));
  process.exit(1);
}
console.log(`[${body.mode}] ${body.refused ? `REFUSED (${body.refusalReason})` : "answered"}  ${body.latencyMs} ms  retrieved ${body.retrievedCount}  injection:${body.injectionDetected}`);
console.log(`\n${body.answer}\n`);
for (const s of body.sources ?? []) console.log(`  [${s.n}] ${s.title}: ${s.section}  (${s.docId}${s.isLatest ? "" : ", OLDER VERSION"})`);
for (const s of body.steps ?? []) console.log(`  step ${s.step}: ${s.tool} ${JSON.stringify(s.input)} -> ${s.error ? `ERROR ${s.error}` : `${s.found} results`}`);
const a = body.audit ?? {};
console.log(`\n  tokens in ${a.input_tokens} out ${a.output_tokens}  cost $${Number(a.cost_usd ?? 0).toFixed(5)}  model ${a.model}${a.fell_back ? " (fallback ran)" : ""}`);

export {};
