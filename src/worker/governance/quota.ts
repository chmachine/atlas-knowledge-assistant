import { DAILY_QUESTIONS_GLOBAL, DAILY_QUESTIONS_PER_IP, DAILY_QUESTIONS_PER_USER } from "../../config";
import { dayBucket, hit, peek } from "./limits";

export class LimitError extends Error {
  constructor(
    public scope: "global" | "user" | "ip",
    public limit: number,
  ) {
    super(`daily limit reached (${scope})`);
  }
}

export interface Quota {
  used: number;
  limit: number;
  /** Start of the next UTC day, when the counters reset. */
  resetsAt: string;
}

const keys = (userId: string, ipHash: string, now: Date) => {
  const day = dayBucket(now);
  return { global: `ask:global:${day}`, user: `ask:user:${userId}:${day}`, ip: `ask:ip:${ipHash}:${day}` };
};
const nextMidnight = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();

/** Spend caps for a public demo: per user, per network address and for everybody, per UTC day. */
export async function consumeQuota(db: D1Database, userId: string, ipHash: string, now: Date = new Date()): Promise<Quota> {
  const k = keys(userId, ipHash, now);
  const [g, u, i] = await Promise.all([peek(db, k.global), peek(db, k.user), peek(db, k.ip)]);
  if (g >= DAILY_QUESTIONS_GLOBAL) throw new LimitError("global", DAILY_QUESTIONS_GLOBAL);
  if (u >= DAILY_QUESTIONS_PER_USER) throw new LimitError("user", DAILY_QUESTIONS_PER_USER);
  if (i >= DAILY_QUESTIONS_PER_IP) throw new LimitError("ip", DAILY_QUESTIONS_PER_IP);
  await hit(db, k.global, now);
  const used = await hit(db, k.user, now);
  await hit(db, k.ip, now);
  return { used, limit: DAILY_QUESTIONS_PER_USER, resetsAt: nextMidnight(now) };
}

export async function quotaFor(db: D1Database, userId: string, now: Date = new Date()): Promise<Quota> {
  return { used: await peek(db, keys(userId, "", now).user), limit: DAILY_QUESTIONS_PER_USER, resetsAt: nextMidnight(now) };
}
