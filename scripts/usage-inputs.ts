import { readFileSync } from "node:fs";
import type { Role } from "../src/worker/access/policy";
import { evalCaseSchema } from "../src/worker/eval/schema";
import { chunkDocument } from "../src/worker/ingest/chunker";
import { parseDocument } from "../src/worker/ingest/frontmatter";
import type { SimDoc, SimQuestion, UsageInputs } from "../src/worker/simulate/usage";
import { loadCorpus } from "./check-corpus";

/** The real questions (probe and eval sets) and the real sections of the corpus, as input for the usage simulation. */
export function loadUsageInputs(): UsageInputs {
  const probe = JSON.parse(readFileSync("eval/probe.json", "utf8")) as { role: Role; question: string; expect: string[] | null }[];
  const cases = (JSON.parse(readFileSync("eval/cases.json", "utf8")) as unknown[]).map((c) => evalCaseSchema.parse(c));
  const seen = new Set<string>();
  const questions: SimQuestion[] = [];
  const add = (q: SimQuestion) => {
    if (seen.has(q.question)) return;
    seen.add(q.question);
    questions.push(q);
  };
  for (const p of probe) add({ role: p.role, question: p.question, docs: p.expect ?? [], refuse: !p.expect?.length });
  for (const c of cases) add({ role: c.role, question: c.question, docs: c.expected_docs, refuse: c.expect_refusal });

  const docs: SimDoc[] = loadCorpus().map((f) => {
    const { meta, body } = parseDocument(f.raw);
    return { id: meta.id, title: meta.title, access: meta.access, chunks: chunkDocument({ id: meta.id, language: meta.language }, body).map((c) => ({ id: c.id, section: c.sectionPath })) };
  });
  return { questions, docs };
}
