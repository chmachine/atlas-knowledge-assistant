import { DEFAULT_MINUTES_PER_SEARCH } from "../../config";

// Editable assumptions. The only one so far is how many minutes a manual search for an answer takes, which turns answered
// questions into "time saved" on the dashboard. It is an assumption and the dashboard labels it as one.

export const MINUTES_KEY = "minutes_per_search";
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 60;

export interface Assumption {
  minutes_per_search: number;
  /** Who changed it last and when. Null while the default is in use. */
  updated_by: string | null;
  updated_at: string | null;
}

export async function getAssumption(db: D1Database): Promise<Assumption> {
  const row = await db.prepare("SELECT value, updated_by, updated_at FROM settings WHERE key = ?").bind(MINUTES_KEY).first<{ value: string; updated_by: string | null; updated_at: string }>();
  const stored = row ? Number(row.value) : NaN;
  // A value outside the allowed range (edited by hand in the database) is ignored rather than trusted.
  if (!row || !Number.isInteger(stored) || stored < MIN_MINUTES || stored > MAX_MINUTES) return { minutes_per_search: DEFAULT_MINUTES_PER_SEARCH, updated_by: null, updated_at: null };
  return { minutes_per_search: stored, updated_by: row.updated_by, updated_at: row.updated_at };
}

export async function setMinutesPerSearch(db: D1Database, minutes: number, updatedBy: string, now: Date = new Date()): Promise<Assumption> {
  await db
    .prepare("INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at")
    .bind(MINUTES_KEY, String(minutes), updatedBy, now.toISOString())
    .run();
  return getAssumption(db);
}
