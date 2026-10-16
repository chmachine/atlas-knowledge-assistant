// Fixed-window counters in D1. The window is part of the key (hour or day), so a new window starts at a new key.

/** Increments the counter and returns the new value. Atomic: one statement. */
export async function hit(db: D1Database, key: string, now: Date = new Date()): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO rate_counters (key, count, updated_at) VALUES (?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at
       RETURNING count`,
    )
    .bind(key, now.toISOString())
    .first<{ count: number }>();
  return row?.count ?? 1;
}

/** Counts one use and says whether this use is already over the limit. */
export async function overLimit(db: D1Database, key: string, limit: number, now: Date = new Date()): Promise<boolean> {
  return (await hit(db, key, now)) > limit;
}

/** Reads a counter without changing it. */
export async function peek(db: D1Database, key: string): Promise<number> {
  const row = await db.prepare("SELECT count FROM rate_counters WHERE key = ?").bind(key).first<{ count: number }>();
  return row?.count ?? 0;
}

/** Deletes counters not touched since `olderThan`. Cheap thanks to the updated_at index. */
export async function pruneCounters(db: D1Database, olderThan: Date): Promise<void> {
  await db.prepare("DELETE FROM rate_counters WHERE updated_at < ?").bind(olderThan.toISOString()).run();
}

export const hourBucket = (d: Date = new Date()) => d.toISOString().slice(0, 13); // 2026-10-14T21
export const dayBucket = (d: Date = new Date()) => d.toISOString().slice(0, 10); // 2026-10-14
