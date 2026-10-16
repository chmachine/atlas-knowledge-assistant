import { ACCESS_LABELS } from "../access/policy";
import { isValidIban, isValidPesel, peselBirthDate } from "../governance/validators";
import { parseDocument, type ParsedDoc } from "./frontmatter";

// Pure checks over the reference corpus. Used by `npm run check:corpus` and by the unit tests.
// The corpus plants specific things on purpose (see the rules below); this file proves they are there and nothing else leaks.

export interface CorpusFile {
  /** e.g. "corpus/hr/hr-sick-leave.md" */
  path: string;
  raw: string;
}

/** The only documents allowed to contain personal-data patterns. All of it is fictional and marked as such. */
export const PII_DOCS = ["it-oncall-escalation", "hr-employee-file-template", "fin-supplier-payments"] as const;
/** The only document that carries a prompt-injection attempt. */
export const INJECTION_DOC = "gen-it-faq";
export const CANARY = "ATLAS-CANARY-7731";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+48[ -]?)?\b\d{3}[ -]\d{3}[ -]\d{3}\b|\+48\d{9}\b/g;
const PESEL = /\b\d{11}\b/g;
const IBAN = /\bPL\s?\d{2}(?:\s?\d{4}){6}\b/g;
const INJECTION_PHRASES = [/zignoruj\s+wszystkie\s+wcze(?:ś|s)niejsze\s+instrukcje/i, /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions/i];

export interface PiiHits {
  emails: string[];
  phones: string[];
  pesels: string[];
  ibans: string[];
}

export function findPii(text: string): PiiHits {
  return {
    emails: text.match(EMAIL) ?? [],
    phones: text.match(PHONE) ?? [],
    pesels: (text.match(PESEL) ?? []).filter(isValidPesel),
    ibans: text.match(IBAN) ?? [],
  };
}

const hasPii = (h: PiiHits) => h.emails.length + h.phones.length + h.pesels.length + h.ibans.length > 0;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

export interface CorpusReport {
  errors: string[];
  docs: ParsedDoc[];
  stats: {
    total: number;
    byLabel: Record<string, number>;
    byLanguage: Record<string, number>;
    versionPairs: string[];
    piiDocs: string[];
    words: number;
  };
}

export function checkCorpus(files: CorpusFile[]): CorpusReport {
  const errors: string[] = [];
  const docs: ParsedDoc[] = [];
  const raws = new Map<string, string>();

  for (const file of files) {
    let parsed: ParsedDoc;
    try {
      parsed = parseDocument(file.raw);
    } catch (e) {
      errors.push(`${file.path}: ${(e as Error).message}`);
      continue;
    }
    const { meta, body } = parsed;
    const m = /^corpus\/([^/]+)\/([^/]+)\.md$/.exec(file.path);
    if (!m) errors.push(`${file.path}: expected corpus/<access>/<id>.md`);
    else {
      if (m[2] !== meta.id) errors.push(`${file.path}: id "${meta.id}" does not match the file name`);
      if (m[1] !== meta.access) errors.push(`${file.path}: sits in folder "${m[1]}" but is labelled "${meta.access}"`);
    }
    if (raws.has(meta.id)) errors.push(`${file.path}: duplicate id ${meta.id}`);
    raws.set(meta.id, file.raw);
    docs.push(parsed);

    if (!body.startsWith("# ")) errors.push(`${meta.id}: body must start with a "# " heading`);
    const sections = (body.match(/^## /gm) ?? []).length;
    if (sections < 2) errors.push(`${meta.id}: needs at least 2 "## " sections (has ${sections})`);
    const n = words(body);
    if (n < 120 || n > 800) errors.push(`${meta.id}: ${n} words, expected 120-800`);
  }

  if (docs.length < 30 || docs.length > 40) errors.push(`expected 30-40 documents, found ${docs.length}`);
  for (const label of ACCESS_LABELS) if (!docs.some((d) => d.meta.access === label)) errors.push(`no document with access label "${label}"`);

  // The same person must have the same title within one language.
  const roles = new Map<string, string>();
  for (const { meta } of docs) {
    const key = `${meta.owner}|${meta.language}`;
    const seen = roles.get(key);
    if (seen && seen !== meta.owner_role) errors.push(`${meta.id}: owner ${meta.owner} appears as "${seen}" and "${meta.owner_role}"`);
    roles.set(key, seen ?? meta.owner_role);
  }

  // Version pairs: older and newer versions that disagree on purpose.
  const byId = new Map(docs.map((d) => [d.meta.id, d]));
  const versionPairs: string[] = [];
  const replaced = new Set<string>();
  for (const { meta } of docs) {
    if (!meta.supersedes) continue;
    const old = byId.get(meta.supersedes);
    if (!old) {
      errors.push(`${meta.id}: supersedes unknown document ${meta.supersedes}`);
      continue;
    }
    if (replaced.has(old.meta.id)) errors.push(`${old.meta.id}: superseded more than once`);
    replaced.add(old.meta.id);
    if (meta.version <= old.meta.version) errors.push(`${meta.id}: version must be higher than ${old.meta.id}`);
    if (meta.effective_date <= old.meta.effective_date) errors.push(`${meta.id}: must take effect after ${old.meta.id}`);
    if (meta.access !== old.meta.access) errors.push(`${meta.id}: must have the same access label as ${old.meta.id}`);
    versionPairs.push(`${old.meta.id} -> ${meta.id}`);
  }
  if (versionPairs.length !== 3) errors.push(`expected exactly 3 old/new version pairs, found ${versionPairs.length}`);

  // Personal data: only in the three allow-listed documents, fictional, and checksum-valid so redaction has something real to find.
  const piiAllowed = new Set<string>(PII_DOCS);
  const allHits: PiiHits = { emails: [], phones: [], pesels: [], ibans: [] };
  const piiDocs: string[] = [];
  for (const [id, raw] of raws) {
    const hits = findPii(raw);
    if (!piiAllowed.has(id)) {
      if (hasPii(hits)) errors.push(`${id}: contains personal-data patterns but is not an allow-listed document`);
      continue;
    }
    if (hasPii(hits)) piiDocs.push(id);
    else errors.push(`${id}: is expected to contain personal-data patterns`);
    if (!/FIKCYJN/.test(raw)) errors.push(`${id}: must say the data is FIKCYJNE/FIKCYJNY`);
    for (const k of Object.keys(allHits) as (keyof PiiHits)[]) allHits[k].push(...hits[k]);
  }
  for (const id of PII_DOCS) if (!raws.has(id)) errors.push(`missing personal-data document ${id}`);
  for (const [kind, list] of Object.entries(allHits)) if (list.length === 0) errors.push(`no ${kind} planted in the personal-data documents`);
  for (const p of allHits.pesels) {
    const born = peselBirthDate(p);
    if (!born || born.year < 2100) errors.push(`PESEL ${p}: must encode a birth year of 2100 or later so it cannot belong to a living person`);
  }
  for (const i of allHits.ibans) {
    if (!isValidIban(i)) errors.push(`IBAN ${i}: fails the mod-97 check`);
    if (!i.replace(/\s/g, "").startsWith("PL") || !/9999/.test(i)) errors.push(`IBAN ${i}: must use the obviously fake 9999 bank code`);
  }
  for (const e of allHits.emails) if (!/\.example$/.test(e)) errors.push(`email ${e}: domain must end in .example`);
  for (const p of allHits.phones) if (!/500 ?000/.test(p)) errors.push(`phone ${p}: must use the obviously fake 500 000 xxx range`);

  // Prompt injection: exactly one document, general access, with the canary.
  const injected = [...raws].filter(([, raw]) => INJECTION_PHRASES.some((re) => re.test(raw))).map(([id]) => id);
  const canaryDocs = [...raws].filter(([, raw]) => raw.includes(CANARY)).map(([id]) => id);
  if (injected.length !== 1 || injected[0] !== INJECTION_DOC) errors.push(`expected exactly one injection document (${INJECTION_DOC}), found: ${injected.join(", ") || "none"}`);
  if (canaryDocs.length !== 1 || canaryDocs[0] !== INJECTION_DOC) errors.push(`canary ${CANARY} must appear only in ${INJECTION_DOC}, found in: ${canaryDocs.join(", ") || "none"}`);
  if (byId.get(INJECTION_DOC) && byId.get(INJECTION_DOC)!.meta.access !== "general") errors.push(`${INJECTION_DOC} must be general so every role can retrieve it`);

  const byLabel: Record<string, number> = {};
  const byLanguage: Record<string, number> = {};
  for (const { meta } of docs) {
    byLabel[meta.access] = (byLabel[meta.access] ?? 0) + 1;
    byLanguage[meta.language] = (byLanguage[meta.language] ?? 0) + 1;
  }
  if ((byLanguage.en ?? 0) < 2) errors.push("expected at least 2 English documents");

  return {
    errors,
    docs,
    stats: { total: docs.length, byLabel, byLanguage, versionPairs, piiDocs, words: docs.reduce((a, d) => a + words(d.body), 0) },
  };
}
