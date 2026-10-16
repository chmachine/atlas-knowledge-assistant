import { isValidIban, isValidPesel, peselBirthDate } from "./validators";

// Redacts personal data (email, IBAN, phone, PESEL) from text. It runs:
//   - on the question, before it is embedded, sent to the model or logged,
//   - on every document chunk and tool result, before it reaches the model,
//   - on the answer and on anything written to the audit log, and on the source preview.
// It is pattern based, not a DLP product: it does not recognise names or addresses, and it can be fooled by deliberate obfuscation.
// The bias is toward redacting when a pattern is distinctive (labelled PESEL, PL-prefixed IBAN) and toward leaving text alone when it is
// not (a bare 11-digit number must pass the PESEL checksum), so invoice and order numbers survive.

export type PiiKind = "EMAIL" | "IBAN" | "PHONE" | "PESEL";
export interface Redaction {
  text: string;
  counts: Record<PiiKind, number>;
  total: number;
}

const PLACEHOLDER: Record<PiiKind, string> = { EMAIL: "[EMAIL]", IBAN: "[IBAN]", PHONE: "[PHONE]", PESEL: "[PESEL]" };

const NOT_ALNUM_BEFORE = String.raw`(?<![\p{L}\p{N}])`;

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

// IBAN: "PL" + 26 digits, with optional spaces or hyphens. The PL prefix is distinctive enough to redact even with a wrong checksum.
const IBAN_PL = new RegExp(`${NOT_ALNUM_BEFORE}PL[ -]?\\d{2}(?:[ -]?\\d{4}){6}(?!\\d)`, "giu");
// Bare 26 digits (a Polish account number written without PL): only redacted when the mod-97 check passes.
const IBAN_BARE = new RegExp(`${NOT_ALNUM_BEFORE}\\d{2}(?:[ -]?\\d{4}){6}(?!\\d)`, "gu");

// Phone numbers.
// 1) international: +48 600 100 200, +48600100200, (+48) 600 100 200, 0048 600 100 200, +49 170 1234567
const PHONE_INTL = new RegExp(`${NOT_ALNUM_BEFORE}\\(?(?:\\+|00)\\d{1,3}\\)?(?:[ .-]?\\d){8,12}(?!\\d)`, "gu");
// 2) domestic with separators: 600 100 200, 600-100-200, 12 345 67 89, (12) 345 67 89
const PHONE_DOMESTIC = new RegExp(
  `${NOT_ALNUM_BEFORE}(?:\\d{3}[ -]\\d{3}[ -]\\d{3}|\\d{2}[ -]\\d{3}[ -]\\d{2}[ -]\\d{2}|\\(\\d{2}\\)\\s?\\d{3}[ -]?\\d{2}[ -]?\\d{2})(?!\\d)`,
  "gu",
);
// 3) nine bare digits, only when a label says it is a phone number: "tel. 600100200"
const PHONE_LABELLED = /(\b(?:tel(?:efon)?|kom(?:órka)?|mob(?:ile)?|phone|fax|whatsapp)\b\.?:?\s*)(\d{9})(?!\d)/giu;
// A 3-3-3 digit group followed by a unit is an amount or quantity ("100 000 000 zł"), not a phone number.
const UNIT_AFTER = /^\s*(?:zł|zl|pln|eur|usd|€|\$|%|kg|szt|palet)/i;

// PESEL: 11 digits. Labelled ones are redacted outright; bare ones must pass the checksum and encode a possible date.
const PESEL_LABELLED = /(\bPESEL\b[:\s-]*)(\d{11})(?!\d)/giu;
const PESEL_BARE = new RegExp(`${NOT_ALNUM_BEFORE}\\d{11}(?![\\p{N}])`, "gu");

export function redact(input: string): Redaction {
  const counts: Record<PiiKind, number> = { EMAIL: 0, IBAN: 0, PHONE: 0, PESEL: 0 };
  const hit = (kind: PiiKind) => {
    counts[kind]++;
    return PLACEHOLDER[kind];
  };
  let text = input;

  text = text.replace(EMAIL, () => hit("EMAIL"));
  text = text.replace(IBAN_PL, () => hit("IBAN"));
  text = text.replace(IBAN_BARE, (m) => (isValidIban(`PL${m.replace(/[ -]/g, "")}`) ? hit("IBAN") : m));
  text = text.replace(PHONE_INTL, () => hit("PHONE"));
  text = text.replace(PHONE_DOMESTIC, (m: string, offset: number, whole: string) =>
    UNIT_AFTER.test(whole.slice(offset + m.length)) ? m : hit("PHONE"),
  );
  text = text.replace(PHONE_LABELLED, (_m, label: string) => `${label}${hit("PHONE")}`);
  text = text.replace(PESEL_LABELLED, (_m, label: string) => `${label}${hit("PESEL")}`);
  text = text.replace(PESEL_BARE, (m) => (isValidPesel(m) && peselBirthDate(m) ? hit("PESEL") : m));

  return { text, counts, total: counts.EMAIL + counts.IBAN + counts.PHONE + counts.PESEL };
}

export const redactText = (input: string): string => redact(input).text;

/** Redacts every string inside an object or array (for tool-call logs and audit records). Other values are returned as they are. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  }
  return value;
}

export function addCounts(a: Record<PiiKind, number>, b: Record<PiiKind, number>): Record<PiiKind, number> {
  return { EMAIL: a.EMAIL + b.EMAIL, IBAN: a.IBAN + b.IBAN, PHONE: a.PHONE + b.PHONE, PESEL: a.PESEL + b.PESEL };
}
