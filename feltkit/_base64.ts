/**
 * Base64 without Node's Buffer, so the same code runs on FeltKit's Node runtime and inside an
 * AppBoundry artifact (whose guest has no Node APIs). Strict: anything that is not standard base64
 * (padding optional, whitespace ignored) is refused rather than silently decoded.
 */
import { fail } from "@feltdb/feltkit";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "").replace(/=+$/, "");
  if (clean.length % 4 === 1) fail("INVALID_ARGUMENT", "The file is not valid base64.");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let n = 0;
  for (const c of clean) {
    const v = INDEX.get(c);
    if (v === undefined) fail("INVALID_ARGUMENT", "The file is not valid base64.");
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (value >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i]!, bytes[i + 1], bytes[i + 2]];
    const v = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += ALPHABET[(v >> 18) & 63]! + ALPHABET[(v >> 12) & 63]! + (b === undefined ? "=" : ALPHABET[(v >> 6) & 63]!) + (c === undefined ? "=" : ALPHABET[v & 63]!);
  }
  return out;
}
