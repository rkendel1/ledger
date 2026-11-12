/**
 * The vendored Stack UI packages (vendor/stack-ui) are unmodified copies of a recorded release:
 * every file matches SHA256SUMS, as stack-ui's release process requires of each consuming product
 * (stack-ui docs/release.md). Update them only with stack-ui's scripts/vendor-packages.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(process.cwd(), "vendor", "stack-ui");

test("vendored Stack UI matches its SHA256SUMS, file for file", () => {
  const listed = new Map(readFileSync(join(root, "SHA256SUMS"), "utf8").trim().split("\n").map((line) => {
    const [sum, file] = line.split(/\s+/);
    return [file!, sum!];
  }));
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  const files = walk(root).map((f) => relative(root, f).split("\\").join("/")).filter((f) => f !== "SHA256SUMS" && f !== "README.md").sort();
  assert.deepEqual(files, [...listed.keys()].sort(), "no files added or removed");
  for (const file of files) {
    assert.equal(createHash("sha256").update(readFileSync(join(root, file))).digest("hex"), listed.get(file), `${file} was modified`);
  }
  const version = JSON.parse(readFileSync(join(root, "core", "package.json"), "utf8")).version;
  assert.equal(version, "0.9.0");
});

test("the vendored FeltKit pre-release is the recorded tarball, and package.json installs exactly it", () => {
  const dir = join(process.cwd(), "vendor", "feltkit");
  const [line] = readFileSync(join(dir, "SHA256SUMS"), "utf8").trim().split("\n");
  const [sum, file] = line!.split(/\s+/);
  assert.equal(createHash("sha256").update(readFileSync(join(dir, file!))).digest("hex"), sum, `${file} was modified`);
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  assert.equal(pkg.dependencies["@feltdb/feltkit"], `file:vendor/feltkit/${file}`);
});
