/**
 * The AppBoundry artifact (`feltkit build --target appboundry` → ledger.app), run in FeltKit's
 * reference guest host. It records what works there today and what the platform blocks:
 * an artifact session carries no organization (tenant), so Ledger's books are closed (GAP-REGISTER G-05).
 * Run with `npm run test:artifact` (builds first).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createArtifactTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";

test("the artifact loads its functions; organization-scoped calls are closed because artifact sessions carry no tenant", async () => {
  assert.ok(existsSync("ledger.app"), "build it first: npx feltkit build --target appboundry");
  const t = await createArtifactTestApp("ledger.app");
  try {
    const ada = t.as({ id: "ada", type: "user", roles: ["owner"] });
    const me = await ada.query(api.org.me, {});
    assert.equal(me.tenant, null, "no organization in an artifact session");
    await assert.rejects(ada.query(api.org.settings, {}), (e: any) => e.code === "FAILED_PRECONDITION");
    await assert.rejects(ada.mutation(api.org.setup, { legalName: "X", baseCurrency: "USD", fiscalYearStartMonth: 1 }), (e: any) => e.code === "FAILED_PRECONDITION");
  } finally {
    await t.close();
  }
});
