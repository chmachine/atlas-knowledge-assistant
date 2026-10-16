import { describe, expect, it } from "vitest";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../src/worker/auth/password";

describe("password hashing", () => {
  it("round-trips and rejects a wrong password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored.startsWith("pbkdf2-sha256$100000$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("correct horse battery stapler", stored)).toBe(false);
  });

  it("uses a fresh salt every time", async () => {
    const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);
    expect(a).not.toBe(b);
  });

  it("rejects malformed or hostile stored values instead of throwing", async () => {
    for (const stored of ["", "plain", "pbkdf2-sha256$1$x", "bcrypt$10$a$b", "pbkdf2-sha256$99999999$AA==$AA==", "pbkdf2-sha256$abc$AA==$AA=="]) {
      expect(await verifyPassword("x", stored)).toBe(false);
    }
  });

  it("the dummy hash is well formed but matches nothing", async () => {
    expect(await verifyPassword("", DUMMY_HASH)).toBe(false);
    expect(await verifyPassword("password", DUMMY_HASH)).toBe(false);
  });
});
