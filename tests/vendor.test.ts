/**
 * Ledger's one vendored dependency: a FeltKit build that is not on npm yet (vendor/feltkit/README.md).
 * The tarball must be the recorded one, and package.json must install exactly it. Stack UI comes from
 * npm (0.9.0, published unchanged from the copy Ledger vendored before).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the vendored FeltKit build is the recorded tarball, and package.json installs exactly it", () => {
  const dir = join(process.cwd(), "vendor", "feltkit");
  const [line] = readFileSync(join(dir, "SHA256SUMS"), "utf8").trim().split("\n");
  const [sum, file] = line!.split(/\s+/);
  assert.equal(createHash("sha256").update(readFileSync(join(dir, file!))).digest("hex"), sum, `${file} was modified`);
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  assert.equal(pkg.dependencies["@feltdb/feltkit"], `file:vendor/feltkit/${file}`);
});
