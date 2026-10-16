import { fromBase64, timingSafeEqual, toBase64 } from "../util/crypto";

// PBKDF2-SHA256 through WebCrypto. Cloudflare Workers allow at most 100,000 iterations.
const ITERATIONS = 100_000;
const MAX_ITERATIONS = 100_000;
const KEY_BITS = 256;
const SCHEME = "pbkdf2-sha256";

const encoder = new TextEncoder();

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, KEY_BITS);
  return new Uint8Array(bits);
}

/** Returns `pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return `${SCHEME}$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterRaw, saltB64, hashB64] = stored.split("$");
  if (scheme !== SCHEME || !iterRaw || !saltB64 || !hashB64) return false;
  const iterations = Number(iterRaw);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) return false;
  try {
    const actual = await derive(password, fromBase64(saltB64), iterations);
    return timingSafeEqual(actual, fromBase64(hashB64));
  } catch {
    return false;
  }
}

/** A well-formed hash nobody knows the password of. Verified against when the username does not exist, so timing does not reveal it. */
export const DUMMY_HASH = `${SCHEME}$${ITERATIONS}$${toBase64(new Uint8Array(16))}$${toBase64(new Uint8Array(32))}`;
