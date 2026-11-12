/** Ledger's portable base64 (feltkit/_base64.ts) equals Node's on edge cases and random bytes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromBase64, toBase64 } from "../feltkit/_base64.js";

test("base64 without Buffer matches Node's, both ways, and refuses what is not base64", () => {
  const cases = [new Uint8Array([]), new Uint8Array([0]), new Uint8Array([255, 254]), new Uint8Array([1, 2, 3]), new TextEncoder().encode("receipt bytes")];
  let seed = 7;
  for (let n = 0; n < 300; n++) {
    const bytes = new Uint8Array(n % 97);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (seed = (seed * 1103515245 + 12345) >>> 0) & 0xff;
    cases.push(bytes);
  }
  for (const bytes of cases) {
    const node = Buffer.from(bytes).toString("base64");
    assert.equal(toBase64(bytes), node);
    assert.deepEqual([...fromBase64(node)], [...bytes]);
    assert.deepEqual([...fromBase64(node.replace(/=+$/, ""))], [...bytes], "padding optional");
  }
  assert.throws(() => fromBase64("ab$d"), { code: "INVALID_ARGUMENT" });
  assert.throws(() => fromBase64("abcde"), { code: "INVALID_ARGUMENT" });
});
