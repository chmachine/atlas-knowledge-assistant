// Usage: npx tsx scripts/seed-usage.ts [--days 14] [--end YYYY-MM-DD] [--seed N] [--out file.sql] [--apply local|remote [--yes]]
//
// Generates two weeks of SIMULATED usage (audit rows with source = 'simulated') for the admin dashboard. The same seed and end date
// always give the same rows. Without --out and --apply the SQL goes to stdout. --apply runs it with wrangler against the local or the
// real database, replacing earlier simulated rows only (never live or eval rows). The real database needs --yes: it changes the
// public demo, so ask the owner first.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DAYS, DEFAULT_SEED, generateUsage, renderSql } from "../src/worker/simulate/usage";
import { loadUsageInputs } from "./usage-inputs";

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const num = (name: string, fallback: number) => {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`${name} must be a whole number of at least 1`);
    process.exit(2);
  }
  return n;
};

const end = arg("--end");
if (end !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
  console.error("--end must look like 2026-10-15");
  process.exit(2);
}
const apply = arg("--apply");
if (apply !== undefined && apply !== "local" && apply !== "remote") {
  console.error("--apply must be local or remote");
  process.exit(2);
}
if (apply === "remote" && !argv.includes("--yes")) {
  console.error("This changes the real database behind the public demo. Ask the owner, then add --yes.");
  process.exit(2);
}

const now = end ? new Date(`${end}T23:59:59.999Z`) : new Date();
const rows = generateUsage(loadUsageInputs(), { now, days: num("--days", DEFAULT_DAYS), seed: num("--seed", DEFAULT_SEED) });
const sql = renderSql(rows);

const users = new Set(rows.map((r) => r.user_id)).size;
const answered = rows.filter((r) => !r.refused).length;
console.error(`${rows.length} simulated questions from ${users} fictional users, ${rows[0]?.created_at.slice(0, 10)} to ${rows.at(-1)?.created_at.slice(0, 10)}; ${answered} answered, ${rows.length - answered} refused or failed.`);

if (arg("--out")) writeFileSync(arg("--out")!, sql);
if (apply) {
  const file = join(mkdtempSync(join(tmpdir(), "kb-sim-")), "seed-usage.sql");
  writeFileSync(file, sql);
  execFileSync("npx", ["wrangler", "d1", "execute", "DB", apply === "remote" ? "--remote" : "--local", "--file", file], { stdio: "inherit" });
  console.error(`Applied to the ${apply} database.`);
} else if (!arg("--out")) {
  process.stdout.write(sql);
}
