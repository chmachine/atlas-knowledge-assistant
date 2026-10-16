import { beforeAll, describe, expect, it } from "vitest";
import { loadCorpus } from "../scripts/check-corpus";
import { ACCESS_LABELS, ROLES, allowedLabels, canAccess, sqlLabels, vectorFilter } from "../src/worker/access/policy";
import { ingestDocument } from "../src/worker/ingest/indexer";
import { ftsQuery, getChunksByIds, getDocumentChunks, listDocuments, readSection, searchChunks } from "../src/worker/retrieval/store";
import { makeDb, type TestDb } from "./d1";

// MANDATORY: permission filtering in the retrieval layer. The role comes from the session; these tests drive the data layer directly,
// which is exactly where a model, a vector store or a prompt could try to get past it.

const UNKNOWN_ROLES = ["", "admin", "superuser", "HR", "hr ", "__proto__", "owner"];
let db: TestDb;
const labelsOf: Record<string, string> = {}; // chunk id -> label
const docLabel: Record<string, string> = {}; // doc id -> label
let allChunkIds: string[] = [];

beforeAll(async () => {
  db = makeDb();
  for (const f of loadCorpus()) await ingestDocument({ db }, f.raw);
  const rows = (await db.prepare("SELECT id, doc_id, access_label FROM chunks").all<{ id: string; doc_id: string; access_label: string }>()).results;
  for (const r of rows) {
    labelsOf[r.id] = r.access_label;
    docLabel[r.doc_id] = r.access_label;
  }
  allChunkIds = rows.map((r) => r.id);
});

/** Counts how many SQL statements a role triggers. */
function counting(real: D1Database) {
  let prepared = 0;
  const wrapped = new Proxy(real, { get: (t, k, r) => (k === "prepare" ? (sql: string) => (prepared++, t.prepare(sql)) : Reflect.get(t, k, r)) });
  return { db: wrapped as D1Database, count: () => prepared };
}

describe("filter builders", () => {
  it("builds the Vectorize filter and the SQL clause from the policy, and refuses to build one for an unknown role", () => {
    expect(vectorFilter("hr")).toEqual({ access_label: { $in: ["general", "hr"] } });
    expect(vectorFilter("it_ops")).toEqual({ access_label: { $in: ["general", "it", "security"] } });
    expect(sqlLabels("finance", "c.access_label")).toEqual({ clause: "c.access_label IN (?, ?)", params: ["general", "finance"] });
    for (const role of UNKNOWN_ROLES) {
      expect(vectorFilter(role), role).toBeNull();
      expect(sqlLabels(role), role).toBeNull();
    }
  });
});

describe("search_text: a role never sees a chunk it is not allowed to read", () => {
  const queries = [
    "widełki płacowe grupa G3 premia roczna", "ile dni urlopu przysługuje", "zwolnienie lekarskie e-ZLA", "PESEL kartoteka pracownika", "dyżur IT telefon eskalacja",
    "hasło długość znaków MFA", "limit hotelu delegacja", "faktura zatwierdzanie limit", "płatność dostawca IBAN", "zamknięcie miesiąca DR5", "karta firmowa limit",
    "VPN certyfikat błąd", "awaria WMS failover", "backup kopia zapasowa retencja", "incydent bezpieczeństwa UODO 72 godziny", "klasyfikacja danych Zastrzeżone",
    "praca zdalna dni w tygodniu", "kodeks postępowania prezenty", "BHP kamizelka", "reklamacja CMR", "rabat account manager", "parking rezerwacja", "onboarding opiekun",
    "ocena roczna kalibracja", "rekrutacja polecenie premia", "MedPlus karta sportowa", "wynagrodzenie", "limit", "zasady", "dokument",
  ];

  for (const role of [...ROLES, ...UNKNOWN_ROLES]) {
    it(`role "${role}" gets only chunks with allowed labels, for ${queries.length} different questions`, async () => {
      const allowed = allowedLabels(role);
      for (const q of queries) {
        for (const hit of await searchChunks(db, role, q, 20)) {
          expect(allowed as readonly string[], `${role} was given ${hit.id} (${hit.access_label}) for "${q}"`).toContain(hit.access_label);
        }
      }
    });
  }

  it("employee asking for salary bands gets nothing from HR, while hr finds the document first", async () => {
    const asEmployee = await searchChunks(db, "employee", "widełki płacowe grupa G3 premia roczna", 20);
    expect(asEmployee.some((h) => h.doc_id === "hr-salary-bands")).toBe(false);
    expect(asEmployee.every((h) => h.access_label === "general")).toBe(true);
    const asHr = await searchChunks(db, "hr", "widełki płacowe grupa G3 premia roczna", 5);
    expect(asHr[0]!.doc_id).toBe("hr-salary-bands");
  });

  it("each department's documents are found only by that department", async () => {
    const probe = async (role: string, q: string) => new Set((await searchChunks(db, role, q, 20)).map((h) => h.doc_id));
    expect((await probe("finance", "widełki płacowe grupa premia")).has("hr-salary-bands")).toBe(false);
    expect((await probe("hr", "limit noclegu delegacja hotel")).has("fin-expense-policy-v2")).toBe(false);
    expect((await probe("finance", "limit noclegu delegacja hotel")).has("fin-expense-policy-v2")).toBe(true);
    expect((await probe("employee", "limit noclegu delegacja hotel")).has("fin-expense-policy-v2")).toBe(false);
    expect((await probe("hr", "failover węzeł zapasowy AtlasWMS")).has("it-runbook-wms-outage")).toBe(false);
    expect((await probe("it_ops", "failover węzeł zapasowy AtlasWMS")).has("it-runbook-wms-outage")).toBe(true);
  });

  it("returns nothing, and runs no SQL at all, for a role with no access", async () => {
    for (const role of UNKNOWN_ROLES) {
      const { db: counted, count } = counting(db);
      expect(await searchChunks(counted, role, "urlop")).toEqual([]);
      expect(await listDocuments(counted, role)).toEqual([]);
      expect(await getDocumentChunks(counted, role, "gen-onboarding-guide")).toBeNull();
      expect(await readSection(counted, role, "gen-onboarding-guide", "Pierwszy dzień")).toBeNull();
      expect(await getChunksByIds(counted, role, allChunkIds.slice(0, 5))).toEqual([]);
      expect(count(), role).toBe(0);
    }
  });
});

describe("get_chunks_by_ids: the re-check after a vector search", () => {
  it("returns exactly the chunks a role may read, whatever ids a leaky vector store hands back", async () => {
    for (const role of [...ROLES, ...UNKNOWN_ROLES]) {
      const got: string[] = [];
      for (let i = 0; i < allChunkIds.length; i += 50) got.push(...(await getChunksByIds(db, role, allChunkIds.slice(i, i + 50))).map((c) => c.id));
      const expected = allChunkIds.filter((id) => canAccess(role, labelsOf[id]!));
      expect(new Set(got), role).toEqual(new Set(expected));
    }
  });

  it("keeps the order of the ids it was given (the vector ranking)", async () => {
    const ids = ["gen-onboarding-guide#opiekun-buddy", "gen-onboarding-guide#pierwszy-dzien", "gen-onboarding-guide#okres-probny"];
    expect((await getChunksByIds(db, "employee", ids)).map((c) => c.id)).toEqual(ids);
  });
});

describe("list_documents", () => {
  it("lists exactly the documents of the role's labels", async () => {
    const counts = Object.fromEntries(await Promise.all(ROLES.map(async (r) => [r, (await listDocuments(db, r)).length] as const)));
    expect(counts).toEqual({ employee: 11, it_ops: 23, hr: 18, finance: 17 });
    for (const role of ROLES) for (const d of await listDocuments(db, role)) expect(canAccess(role, d.access_label)).toBe(true);
  });

  it("a department filter narrows the result but can never widen access", async () => {
    const hrAsEmployee = await listDocuments(db, "employee", { department: "HR" });
    expect(hrAsEmployee.map((d) => d.id).sort()).toEqual(["gen-onboarding-guide", "gen-remote-work-v1", "gen-remote-work-v2"]);
    expect((await listDocuments(db, "hr", { department: "hr" })).length).toBe(10);
    expect(await listDocuments(db, "employee", { department: "Finanse" })).toEqual([]);
    expect(await listDocuments(db, "employee", { department: "HR' OR '1'='1" })).toEqual([]);
  });

  it("tells which version is current", async () => {
    const docs = await listDocuments(db, "employee");
    expect(docs.find((d) => d.id === "gen-remote-work-v1")).toMatchObject({ is_latest: false, superseded_by: "gen-remote-work-v2" });
    expect(docs.find((d) => d.id === "gen-remote-work-v2")).toMatchObject({ is_latest: true, superseded_by: null });
  });
});

describe("read_section and document reads", () => {
  it("not allowed looks exactly like not existing: the existence of a restricted document is not revealed", async () => {
    const forbidden = await getDocumentChunks(db, "employee", "hr-salary-bands");
    const missing = await getDocumentChunks(db, "employee", "no-such-document");
    expect(forbidden).toBeNull();
    expect(forbidden).toEqual(missing);
    expect(await readSection(db, "employee", "hr-salary-bands", "Premia roczna")).toBeNull();
    expect(await readSection(db, "employee", "no-such-document", "Premia roczna")).toBeNull();
  });

  it("the owning role can read the same section", async () => {
    const section = await readSection(db, "hr", "hr-salary-bands", "Premia roczna");
    expect(section).not.toBeNull();
    expect(section![0]!.text).toContain("18% w grupie G5");
  });

  it("finds a section by anchor, by name, by a part of the name, and by the top-level heading of a subsection", async () => {
    for (const s of ["pierwszy-dzien", "Pierwszy dzień", "PIERWSZY DZIEN", "pierwszy"]) {
      expect((await readSection(db, "employee", "gen-onboarding-guide", s))?.[0]?.section_path, s).toBe("Pierwszy dzień");
    }
    expect(await readSection(db, "employee", "gen-onboarding-guide", "nie ma takiej sekcji")).toBeNull();
    expect(await readSection(db, "employee", "gen-onboarding-guide", "???")).toBeNull();
  });

  it("reading every section of every document is allowed exactly for the roles the policy names", async () => {
    for (const docId of Object.keys(docLabel)) {
      for (const role of ROLES) {
        const chunks = await getDocumentChunks(db, role, docId);
        expect(chunks !== null, `${role} / ${docId}`).toBe(canAccess(role, docLabel[docId]!));
        if (chunks) for (const c of chunks) expect(canAccess(role, c.access_label)).toBe(true);
      }
    }
  });
});

describe("the full-text query builder and SQL injection", () => {
  it("quotes terms, drops short words and stop words, stems long words and caps the length", () => {
    expect(ftsQuery("ile dni urlopu przysługuje?")).toBe('"dni" OR "urlop" OR "przysługu"');
    expect(ftsQuery("a b c")).toBeNull();
    expect(ftsQuery("")).toBeNull();
    expect(ftsQuery("jak jest czy")).toBeNull();
    const many = ftsQuery(Array.from({ length: 40 }, (_, i) => `termin${String.fromCharCode(97 + (i % 26))}${i}`).join(" "))!;
    expect(many.split(" OR ").length).toBeLessThanOrEqual(12);
  });

  it("survives hostile input: no error, no extra rows, tables intact", async () => {
    const hostile = [
      `"; DROP TABLE chunks; --`, `' OR 1=1 --`, `x") OR ("1`, `* ( ) : ^ NEAR/2 AND OR NOT`, `"unterminated`, `chunks_fts MATCH 'a'`, `\u0000\u0001`, `%%%___`, "a".repeat(5000),
    ];
    for (const q of hostile) {
      const hits = await searchChunks(db, "employee", q, 20);
      expect(hits.every((h) => h.access_label === "general"), q).toBe(true);
    }
    expect((await db.prepare("SELECT COUNT(*) AS n FROM chunks").first<{ n: number }>())!.n).toBe(allChunkIds.length);
  });
});

describe("search quality (Polish inflection)", () => {
  it("finds the leave policy from an inflected question", async () => {
    expect((await searchChunks(db, "hr", "ile dni urlopu przysługuje pracownikowi", 3))[0]!.doc_id).toBe("hr-leave-policy");
  });
  it("matches word forms the document does not use verbatim", async () => {
    const top = async (role: string, q: string) => (await searchChunks(db, role, q, 3)).map((h) => h.doc_id);
    expect(await top("employee", "pracy zdalnej")).toContain("gen-remote-work-v2");
    expect(await top("it_ops", "jakie hasła wymagane")).toEqual(expect.arrayContaining(["sec-password-policy-v2"]));
    expect(await top("finance", "faktury powyżej 25 000 zł zatwierdza")).toContain("fin-invoice-approval");
  });
  it("covers every label once, so the access-label list stays in step with the corpus", () => {
    expect(new Set(Object.values(docLabel))).toEqual(new Set(ACCESS_LABELS));
  });
});

// Found by testing on the real D1: the full-text index folds accents (ą ę ó ć ń ś ź ż) but NOT the letter ł, because Unicode has
// no decomposition for it. A search typed without Polish letters still works for most words, but not for words that contain ł.
// The agentic mode's search queries are written by the model with correct Polish letters, so the impact is small; this test pins
// the behaviour so the README can state it, and so a future fix (folding ł in the index) has to update it on purpose.
describe("known limitation: the letter ł is not folded to l", () => {
  const ids = async (q: string) => (await searchChunks(db, "hr", q, 20)).map((h) => h.id);

  it("finds words with other Polish accents when they are typed without them", async () => {
    expect(await ids("zadanie urlopu")).toContain("hr-leave-policy#urlop-na-zadanie"); // heading is "Urlop na żądanie"
  });

  it("does not find a word with ł when it is typed with a plain l, while the correct spelling works", async () => {
    expect(await ids("składa wniosek")).toContain("hr-leave-policy#skladanie-wnioskow");
    expect(await ids("sklada")).not.toContain("hr-leave-policy#skladanie-wnioskow");
  });
});
