import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";

export type TestDb = D1Database & { raw: DatabaseSync };

/**
 * Minimal D1 stand-in over node:sqlite, so the real migrations and real SQL (FTS5 included) run in unit tests.
 * Like D1, it enforces foreign keys. It implements only the calls the Worker code uses.
 */
export function makeDb(): TestDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync("migrations").sort()) raw.exec(readFileSync(`migrations/${file}`, "utf8"));

  const plain = (row: unknown) => (row && typeof row === "object" ? { ...(row as object) } : row);

  const statement = (sql: string, args: unknown[] = []): any => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async (column?: string) => {
      const row = raw.prepare(sql).get(...(args as never[])) as Record<string, unknown> | undefined;
      if (!row) return null;
      return column ? row[column] : plain(row);
    },
    all: async () => ({ results: raw.prepare(sql).all(...(args as never[])).map(plain), success: true, meta: {} }),
    run: async () => {
      const r = raw.prepare(sql).run(...(args as never[]));
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    _exec: () => {
      const stmt = raw.prepare(sql);
      return /^\s*(select|with)|returning/i.test(sql)
        ? { results: stmt.all(...(args as never[])).map(plain), success: true }
        : { meta: { changes: Number(stmt.run(...(args as never[])).changes) }, success: true };
    },
  });

  return {
    raw,
    prepare: (sql: string) => statement(sql),
    // D1 batches run as one transaction.
    batch: async (list: any[]) => {
      raw.exec("BEGIN");
      try {
        const out = list.map((s) => s._exec());
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as TestDb;
}
