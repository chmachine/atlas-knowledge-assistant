import { describe, expect, it } from "vitest";
import { dayBucket, hit, hourBucket, overLimit, peek, pruneCounters } from "../src/worker/governance/limits";
import { makeDb } from "./d1";

describe("rate counters", () => {
  it("counts atomically per key and reports when the limit is exceeded", async () => {
    const db = makeDb();
    expect(await hit(db, "k")).toBe(1);
    expect(await hit(db, "k")).toBe(2);
    expect(await hit(db, "other")).toBe(1);
    expect(await peek(db, "k")).toBe(2);
    expect(await peek(db, "missing")).toBe(0);
    // limit 3: uses 3 (this is the 3rd), 4th is over.
    expect(await overLimit(db, "lim", 3)).toBe(false);
    expect(await overLimit(db, "lim", 3)).toBe(false);
    expect(await overLimit(db, "lim", 3)).toBe(false);
    expect(await overLimit(db, "lim", 3)).toBe(true);
  });

  it("windows are separate keys, and old counters are pruned", async () => {
    const db = makeDb();
    const day1 = new Date("2026-10-14T10:00:00Z");
    const day3 = new Date("2026-10-16T10:00:00Z");
    await hit(db, `ask:${dayBucket(day1)}`, day1);
    await hit(db, `ask:${dayBucket(day3)}`, day3);
    await pruneCounters(db, new Date("2026-10-15T00:00:00Z"));
    expect(await peek(db, `ask:${dayBucket(day1)}`)).toBe(0);
    expect(await peek(db, `ask:${dayBucket(day3)}`)).toBe(1);
  });

  it("bucket helpers use UTC", () => {
    const d = new Date("2026-10-14T21:30:00Z");
    expect(hourBucket(d)).toBe("2026-10-14T21");
    expect(dayBucket(d)).toBe("2026-10-14");
  });
});
