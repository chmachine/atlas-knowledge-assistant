import { z } from "zod";
import { ROLES } from "../access/policy";

// One evaluation case. The file eval/cases.json holds 40 of them; the runner sends each one to the Worker.

export const CATEGORIES = ["answerable", "redaction", "conflict", "injection", "blocked", "out_of_scope"] as const;
export type Category = (typeof CATEGORIES)[number];

/** A fact the answer must convey. `evidence` is an exact phrase from an expected document, so the ground truth is checked against the corpus. */
const fact = z.object({ fact: z.string().min(3).max(200), evidence: z.string().min(3).max(300) });

export const evalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/).max(40),
  role: z.enum(ROLES),
  question: z.string().min(3).max(1000),
  category: z.enum(CATEGORIES),
  /** Documents that hold the answer. Empty for questions that must be refused. */
  expected_docs: z.array(z.string()).max(4),
  key_facts: z.array(fact).max(4),
  /** Strings that must NOT appear in the answer (restricted facts, personal data, the injection canary). */
  must_not_contain: z.array(z.string().min(2).max(200)).max(6).default([]),
  expect_refusal: z.boolean(),
  /** Conflict cases: the older version's fact the answer should mention, and which document holds it. */
  older: z.object({ fact: z.string().min(3).max(200), evidence: z.string().min(3).max(300), doc: z.string() }).optional(),
});
export type EvalCase = z.infer<typeof evalCaseSchema>;
