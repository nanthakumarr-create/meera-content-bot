import { createHash, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison. Both sides are hashed first so the
 * comparison does not leak the secret's length through early exit.
 */
export function safeEqual(provided: string | null | undefined, expected: string): boolean {
  if (typeof provided !== "string" || provided.length === 0 || expected.length === 0) return false;
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

// No 0/O, 1/I/L, to keep IDs easy to read and type from a phone.
const SHORT_ID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const SHORT_ID_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

export function generateShortId(length = 6): string {
  let id = "";
  for (let i = 0; i < length; i += 1) id += SHORT_ID_ALPHABET[randomInt(SHORT_ID_ALPHABET.length)];
  return id;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
