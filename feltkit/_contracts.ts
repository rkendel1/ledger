import { s } from "@feltdb/feltkit";
import type { Schema } from "@feltdb/feltkit";

/**
 * The published output contract of read-only report capabilities: a JSON object. The report shapes
 * are documented in ARCHITECTURE.md; they are not yet published field by field (IMPLEMENTATION.md).
 * The TypeScript type is the report function's own, so callers keep full typing.
 */
export function report<T>(): Schema<T> {
  return s.record(s.unknown()) as unknown as Schema<T>;
}
