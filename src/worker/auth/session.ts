import { SESSION_TTL_HOURS } from "../../config";
import { isRole } from "../access/policy";
import type { SessionUser } from "../env";
import { randomToken, sha256Hex } from "../util/crypto";

/** Creates a session and returns the raw token for the cookie. Only its hash is stored. */
export async function createSession(
  db: D1Database,
  userId: string,
  ipHash: string | null,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_HOURS * 3600_000);
  await db
    .prepare("INSERT INTO sessions (id, user_id, created_at, expires_at, ip_hash) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, now.toISOString(), expiresAt.toISOString(), ipHash)
    .run();
  // Housekeeping: expired sessions are useless; the expires_at index keeps this cheap.
  await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now.toISOString()).run();
  return { token, expiresAt };
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: string;
  is_admin: number;
}

/** Resolves a cookie token to a user, or null when the session is unknown or expired. */
export async function userForToken(db: D1Database, token: string, now: Date = new Date()): Promise<SessionUser | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.is_admin
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ?`,
    )
    .bind(await sha256Hex(token), now.toISOString())
    .first<UserRow>();
  // A role the code does not know is treated as no session at all (deny by default).
  if (!row || !isRole(row.role)) return null;
  return { id: row.id, username: row.username, display_name: row.display_name, role: row.role, is_admin: row.is_admin === 1 };
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256Hex(token)).run();
}
