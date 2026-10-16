import { sha256Hex } from "./crypto";

/** Hash of the caller's IP, for rate limits and session metadata. The raw address is never stored. */
export function ipHashOf(headers: { get(name: string): string | null | undefined } | ((n: string) => string | undefined)): Promise<string> {
  const ip = typeof headers === "function" ? headers("cf-connecting-ip") : headers.get("cf-connecting-ip");
  return sha256Hex(`kb-ip|${ip ?? "unknown"}`);
}
