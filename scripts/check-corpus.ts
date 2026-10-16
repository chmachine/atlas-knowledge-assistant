// Usage: npm run check:corpus
import { readdirSync, readFileSync } from "node:fs";
import { checkCorpus, type CorpusFile } from "../src/worker/ingest/corpus-check";

export function loadCorpus(root = "corpus"): CorpusFile[] {
  const files: CorpusFile[] = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const name of readdirSync(`${root}/${dir.name}`).filter((n) => n.endsWith(".md")).sort()) {
      files.push({ path: `${root}/${dir.name}/${name}`, raw: readFileSync(`${root}/${dir.name}/${name}`, "utf8") });
    }
  }
  return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = checkCorpus(loadCorpus());
  const { stats } = report;
  console.log(`Documents: ${stats.total} (${Object.entries(stats.byLabel).map(([k, v]) => `${k} ${v}`).join(", ")})`);
  console.log(`Languages: ${Object.entries(stats.byLanguage).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`Version pairs (conflicts): ${stats.versionPairs.join("; ")}`);
  console.log(`Documents with fictional personal data: ${stats.piiDocs.join(", ")}`);
  console.log(`Total words: ${stats.words}`);
  if (report.errors.length) {
    console.error(`\n${report.errors.length} problem(s):`);
    for (const e of report.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("\nCorpus OK");
}
