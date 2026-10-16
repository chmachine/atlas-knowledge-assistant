import { describe, expect, it } from "vitest";
import { isValidIban, isValidPesel, peselBirthDate } from "../src/worker/governance/validators";
import { makePesel } from "./pesel";

describe("PESEL", () => {
  it("accepts numbers with a correct control digit", () => {
    expect(isValidPesel("44051401359")).toBe(true); // widely used documentation example
    expect(isValidPesel(makePesel(1990, 5, 14))).toBe(true);
    expect(isValidPesel("12431412345")).toBe(true); // the fictional one in the corpus
  });

  it("rejects a wrong control digit, wrong length and non-digits", () => {
    expect(isValidPesel("44051401358")).toBe(false);
    expect(isValidPesel("4405140135")).toBe(false);
    expect(isValidPesel("440514013590")).toBe(false);
    expect(isValidPesel("4405140135a")).toBe(false);
    expect(isValidPesel("")).toBe(false);
    expect(isValidPesel("00000000000")).toBe(true); // checksum-valid by construction; the redactor still has to decide, see birth date check
  });

  it("decodes the birth date for every century code", () => {
    expect(peselBirthDate(makePesel(1888, 3, 4))).toEqual({ year: 1888, month: 3, day: 4 });
    expect(peselBirthDate(makePesel(1990, 5, 14))).toEqual({ year: 1990, month: 5, day: 14 });
    expect(peselBirthDate(makePesel(2005, 12, 31))).toEqual({ year: 2005, month: 12, day: 31 });
    expect(peselBirthDate(makePesel(2112, 3, 14))).toEqual({ year: 2112, month: 3, day: 14 });
    expect(peselBirthDate(makePesel(2250, 7, 7))).toEqual({ year: 2250, month: 7, day: 7 });
  });

  it("returns null for impossible dates", () => {
    expect(peselBirthDate("44131401359")).toBeNull(); // month 13
    expect(peselBirthDate("44050001359")).toBeNull(); // day 0
    expect(peselBirthDate("not-a-pesel")).toBeNull();
  });
});

describe("IBAN", () => {
  it("accepts valid Polish IBANs with or without spaces and in lower case", () => {
    expect(isValidIban("PL61109010140000071219812874")).toBe(true); // documentation example
    expect(isValidIban("PL61 1090 1014 0000 0712 1981 2874")).toBe(true);
    expect(isValidIban("pl61109010140000071219812874")).toBe(true);
    expect(isValidIban("PL20 9999 0000 0000 0000 0000 0001")).toBe(true); // the fictional one in the corpus
  });

  it("accepts a valid non-Polish IBAN", () => {
    expect(isValidIban("DE89370400440532013000")).toBe(true);
  });

  it("rejects a wrong check, wrong length and junk", () => {
    expect(isValidIban("PL62109010140000071219812874")).toBe(false);
    expect(isValidIban("PL6110901014000007121981287")).toBe(false); // 27 chars
    expect(isValidIban("PL611090101400000712198128745")).toBe(false); // 29 chars
    expect(isValidIban("1234567890")).toBe(false);
    expect(isValidIban("")).toBe(false);
  });
});
