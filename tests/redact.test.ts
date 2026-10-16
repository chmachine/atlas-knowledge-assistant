import { describe, expect, it } from "vitest";
import { loadCorpus } from "../scripts/check-corpus";
import { PII_DOCS, findPii } from "../src/worker/ingest/corpus-check";
import { addCounts, redact, redactDeep, redactText } from "../src/worker/governance/redact";
import { makePesel } from "./pesel";

// Mandatory tests: redaction is what stands between company documents and the model, the logs and the screen.

const r = (s: string) => redactText(s);

describe("PESEL", () => {
  it("redacts a checksum-valid PESEL for people of any birth century", () => {
    for (const year of [1950, 1999, 2005, 2112]) {
      const p = makePesel(year, 6, 15);
      expect(r(`Numer: ${p}.`)).toBe("Numer: [PESEL].");
    }
  });

  it("redacts a labelled PESEL even when the checksum is wrong (a typo is still personal data)", () => {
    expect(r("PESEL: 44051401358")).toBe("PESEL: [PESEL]");
    expect(r("pesel 44051401358")).toBe("pesel [PESEL]");
  });

  it("leaves bare 11-digit numbers that fail the checksum, and numbers inside longer digit strings", () => {
    expect(r("Zamówienie 12345678901 zostało wysłane")).toBe("Zamówienie 12345678901 zostało wysłane");
    expect(r(`Kod ${makePesel(1990, 5, 14)}9`)).toContain(makePesel(1990, 5, 14)); // 12 digits: not a PESEL
  });

  it("redacts several in one text and in a table row", () => {
    const a = makePesel(1980, 1, 1, 1111);
    const b = makePesel(1991, 2, 2, 2222);
    expect(redact(`| ${a} | ${b} |`)).toMatchObject({ text: "| [PESEL] | [PESEL] |", counts: { PESEL: 2 } });
  });
});

describe("email", () => {
  it("redacts common shapes, including Polish letters, plus-tags, subdomains and upper case", () => {
    for (const e of ["jan.kowalski@firma.pl", "a+tag@sub.example.co.uk", "ŁUKASZ.ŻÓŁW@atlas-logistics.example", "X_Y-Z@Atlas.COM"]) {
      expect(r(`Napisz do ${e}, proszę`)).toBe("Napisz do [EMAIL], proszę");
    }
  });

  it("does not eat the sentence-ending period or leave pieces of the address", () => {
    expect(r("Kontakt: jan@firma.pl.")).toBe("Kontakt: [EMAIL].");
    expect(r("(jan@firma.pl)")).toBe("([EMAIL])");
  });

  it("leaves things that are not addresses", () => {
    expect(r("@mention i user@ oraz wersja@2")).toBe("@mention i user@ oraz wersja@2");
  });
});

describe("IBAN", () => {
  const spaced = "PL61 1090 1014 0000 0712 1981 2874";
  const compact = "PL61109010140000071219812874";

  it("redacts spaced, compact, lower-case and hyphenated forms", () => {
    expect(r(`Konto ${spaced}`)).toBe("Konto [IBAN]");
    expect(r(`Konto ${compact}`)).toBe("Konto [IBAN]");
    expect(r(`Konto ${compact.toLowerCase()}`)).toBe("Konto [IBAN]");
    expect(r("Konto PL61-1090-1014-0000-0712-1981-2874")).toBe("Konto [IBAN]");
  });

  it("redacts a Polish account number written without the PL prefix when its checksum is valid", () => {
    expect(r("Rachunek: 61 1090 1014 0000 0712 1981 2874")).toBe("Rachunek: [IBAN]");
    expect(r("Rachunek: 61109010140000071219812874")).toBe("Rachunek: [IBAN]");
  });

  it("redacts a PL-prefixed IBAN with a wrong checksum, but leaves a bare 26-digit number that fails the checksum", () => {
    expect(r("PL62 1090 1014 0000 0712 1981 2874")).toBe("[IBAN]");
    expect(r("Numer seryjny 62109010140000071219812874")).toBe("Numer seryjny 62109010140000071219812874");
  });

  it("never leaves digit groups of an IBAN behind to be mistaken for something else", () => {
    expect(r(`Przelew na ${spaced} w kwocie 15 000 zł`)).toBe("Przelew na [IBAN] w kwocie 15 000 zł");
  });
});

describe("phone numbers", () => {
  const phones = [
    "+48 600 100 200",
    "+48600100200",
    "+48 600-100-200",
    "(+48) 600 100 200",
    "0048 600 100 200",
    "600 100 200",
    "600-100-200",
    "12 345 67 89",
    "(12) 345 67 89",
    "+49 170 1234567",
    "+44 20 7946 0958",
    "tel. 600100200",
    "Telefon: 600100200",
    "mobile 600100200",
  ];
  for (const p of phones) {
    it(`redacts "${p}"`, () => {
      const out = r(`Dzwoń: ${p} po 16:00`);
      expect(out).toMatch(/\[PHONE\]/);
      expect(out).not.toMatch(/\d{3}/); // no digit group of the number survives
    });
  }

  it("keeps the label when it redacts a labelled bare number", () => {
    expect(r("tel. 600100200")).toBe("tel. [PHONE]");
  });

  it("leaves dates, times, amounts, versions, postal codes, ids and ordinary numbers alone", () => {
    const keep = [
      "Data: 2026-10-14 oraz 14.10.2026 i 14/10/2026",
      "Godziny 10:00-14:00 i 9:00 - 15:00",
      "Premia 15 000 zł, limit 25 000 zł netto, 5 000 – 6 500 PLN",
      "Kwota 100 000 000 zł",
      "Przychód 250 000 000 PLN",
      "Faktura FV/2026/10/0123 z dnia 2026-10-14",
      "Kod pocztowy 30-001 Kraków",
      "NIP 123-456-32-18",
      "Błąd AS-403, priorytet P1, Atlas Standard Image v7",
      "ISO/IEC 27001 i RFC 2119",
      "Rabat 10%, 400 palet, 8,33 SDR za kilogram",
      "Aż 1200 zł brutto oraz 60 zł miesięcznie",
      "Numer alarmowy 112",
    ];
    for (const text of keep) expect(r(text)).toBe(text);
  });

  it("leaves a bare 9-digit number with no phone label (it could be an order number)", () => {
    expect(r("Zamówienie 600100200 zostało wysłane")).toBe("Zamówienie 600100200 zostało wysłane");
  });
});

describe("mixed content", () => {
  it("handles several kinds at once and reports the counts, not the values", () => {
    const out = redact(`Jan Testowy, PESEL 12431412345, tel. +48 500 000 201, jan@atlas-logistics.example, konto PL20 9999 0000 0000 0000 0000 0001`);
    expect(out.text).toBe("Jan Testowy, PESEL [PESEL], tel. [PHONE], [EMAIL], konto [IBAN]");
    expect(out.counts).toEqual({ EMAIL: 1, IBAN: 1, PHONE: 1, PESEL: 1 });
    expect(out.total).toBe(4);
    expect(JSON.stringify(out)).not.toMatch(/12431412345|500 000 201|jan@atlas|PL20/);
  });

  it("is idempotent", () => {
    const once = r("PESEL 12431412345 tel +48 500 000 201 a@b.pl PL20 9999 0000 0000 0000 0000 0001");
    expect(r(once)).toBe(once);
  });

  it("returns clean text unchanged and counts nothing", () => {
    expect(redact("Zwykłe zdanie bez danych osobowych.")).toEqual({
      text: "Zwykłe zdanie bez danych osobowych.",
      counts: { EMAIL: 0, IBAN: 0, PHONE: 0, PESEL: 0 },
      total: 0,
    });
  });

  it("redactDeep cleans every string in nested tool-call data and keeps the rest", () => {
    const input = { name: "search_text", input: { query: "konto PL61 1090 1014 0000 0712 1981 2874" }, hits: [{ text: "mail a@b.pl" }, 3, null, true] };
    expect(redactDeep(input)).toEqual({ name: "search_text", input: { query: "konto [IBAN]" }, hits: [{ text: "mail [EMAIL]" }, 3, null, true] });
  });

  it("addCounts sums per kind", () => {
    expect(addCounts({ EMAIL: 1, IBAN: 2, PHONE: 3, PESEL: 4 }, { EMAIL: 1, IBAN: 1, PHONE: 1, PESEL: 1 })).toEqual({ EMAIL: 2, IBAN: 3, PHONE: 4, PESEL: 5 });
  });

  it("handles empty and very long input", () => {
    expect(r("")).toBe("");
    const long = "zwykły tekst ".repeat(20_000);
    expect(r(long)).toBe(long);
  });
});

describe("against the real corpus", () => {
  const corpus = loadCorpus();
  const id = (path: string) => path.split("/").pop()!.replace(".md", "");

  it("changes none of the 33 documents that carry no personal data (no false positives)", () => {
    for (const f of corpus.filter((c) => !PII_DOCS.includes(id(c.path) as never))) {
      expect(r(f.raw), `${f.path} was altered by redaction`).toBe(f.raw);
    }
  });

  it("removes every planted value from the 3 personal-data documents, as judged by the independent corpus checker", () => {
    for (const docId of PII_DOCS) {
      const raw = corpus.find((c) => id(c.path) === docId)!.raw;
      const before = findPii(raw);
      expect(before.emails.length + before.phones.length + before.ibans.length).toBeGreaterThan(0);
      const after = findPii(r(raw));
      expect(after, docId).toEqual({ emails: [], phones: [], pesels: [], ibans: [] });
    }
  });

  it("counts exactly what was planted", () => {
    const count = (docId: string) => redact(corpus.find((c) => id(c.path) === docId)!.raw).counts;
    expect(count("it-oncall-escalation")).toEqual({ EMAIL: 4, IBAN: 0, PHONE: 4, PESEL: 0 });
    expect(count("hr-employee-file-template")).toEqual({ EMAIL: 1, IBAN: 1, PHONE: 1, PESEL: 1 });
    expect(count("fin-supplier-payments")).toEqual({ EMAIL: 3, IBAN: 3, PHONE: 3, PESEL: 0 });
  });

  it("keeps the surrounding text readable (names and structure survive, values do not)", () => {
    const out = r(corpus.find((c) => id(c.path) === "hr-employee-file-template")!.raw);
    expect(out).toContain("| PESEL | [PESEL] |");
    expect(out).toContain("| Imię i nazwisko | Jan Testowy |");
    expect(out).not.toContain("12431412345");
  });
});

// These tests pin what redaction does NOT do. They exist so the README can state the limits truthfully, and so a change that
// quietly widens or narrows the behaviour has to update them on purpose.
describe("known limitations (documented, not hidden)", () => {
  it("does not recognise names or street addresses", () => {
    expect(r("Jan Testowy mieszka przy ul. Przykładowej 5 w Krakowie")).toBe("Jan Testowy mieszka przy ul. Przykładowej 5 w Krakowie");
  });

  it("does not catch deliberately obfuscated values", () => {
    expect(r("jan (at) firma (dot) pl")).toBe("jan (at) firma (dot) pl");
    expect(r("sześćset sto dwieście")).toBe("sześćset sto dwieście");
    expect(r("6 0 0 1 0 0 2 0 0")).toBe("6 0 0 1 0 0 2 0 0");
    expect(r("PESEL: 4405\n1401359")).toContain("4405");
  });

  it("does not treat an unlabelled bare 9-digit number as a phone number", () => {
    expect(r("500100200")).toBe("500100200");
  });
});
