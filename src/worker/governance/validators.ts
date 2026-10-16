// Checksum validators for Polish identifiers. Used by the corpus checker now and by the redactor next:
// a number that fails its checksum is probably an invoice or order number, so it is not treated as personal data.

const PESEL_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];

export function isValidPesel(value: string): boolean {
  if (!/^\d{11}$/.test(value)) return false;
  const digits = [...value].map(Number);
  const sum = PESEL_WEIGHTS.reduce((acc, w, i) => acc + w * (digits[i] ?? 0), 0);
  return (10 - (sum % 10)) % 10 === digits[10];
}

/** Birth date encoded in a PESEL (month offsets: 1800s +80, 1900s +0, 2000s +20, 2100s +40, 2200s +60). Null when impossible. */
export function peselBirthDate(value: string): { year: number; month: number; day: number } | null {
  if (!/^\d{11}$/.test(value)) return null;
  const yy = Number(value.slice(0, 2));
  const mm = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  // floor(mm / 20): 0 -> 1900s (01-12), 1 -> 2000s (21-32), 2 -> 2100s (41-52), 3 -> 2200s (61-72), 4 -> 1800s (81-92)
  const century = ({ 0: 1900, 1: 2000, 2: 2100, 3: 2200, 4: 1800 } as Record<number, number>)[Math.floor(mm / 20)];
  if (century === undefined) return null;
  const month = mm % 20;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year: century + yy, month, day };
}

/** ISO 13616 mod-97 check. Polish IBANs are PL + 26 digits (28 characters), spaces allowed. */
export function isValidIban(value: string): boolean {
  const iban = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  if (iban.startsWith("PL") && iban.length !== 28) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const chunk = code >= 65 ? String(code - 55) : ch; // A=10 ... Z=35
    for (const d of chunk) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}
