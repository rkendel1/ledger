/**
 * Test harness: a real FeltKit runtime on a fresh FeltDB instance, an organization (FeltKit tenant)
 * with one member per role joined through real invitations, and an agent member.
 */
import assert from "node:assert/strict";
import { createTestApp, type Caller, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";

export const ROLE_USERS = {
  owner: "ada",
  admin: "alan",
  accountant: "ana",
  bookkeeper: "grace",
  reviewer: "rita",
} as const;

export interface Org {
  id: string;
  owner: Caller;
  admin: Caller;
  accountant: Caller;
  bookkeeper: Caller;
  reviewer: Caller;
  /** An agent member with the assistant role. */
  agent: Caller;
  /** Account ids by number, from the default chart. */
  acct: Record<string, string>;
}

const principal = (id: string) => ({ id, type: "user" as const, roles: ["person"] });

export async function newOrg(t: TestApp, name = "Boundry LLC", ids: Partial<Record<keyof typeof ROLE_USERS, string>> = {}): Promise<Org> {
  const who = { ...ROLE_USERS, ...ids };
  const tenancy = t.tenancy!;
  const org = await t.provisionTenant(name, { ...principal(who.owner), email: `${who.owner}@example.com` });
  const ownerCtx = await tenancy.context(org.id, who.owner);
  assert.ok(ownerCtx);
  const actor = { ...ownerCtx, principalId: who.owner };
  for (const role of ["admin", "accountant", "bookkeeper", "reviewer"] as const) {
    const { token } = await tenancy.invite(actor, { email: `${who[role]}@example.com`, role });
    await tenancy.accept(token, { ...principal(who[role]), email: `${who[role]}@example.com`, emailVerified: true });
  }
  const agentId = `assistant-${org.id.slice(-6)}`;
  await tenancy.addPrincipal(actor, { id: agentId, type: "agent", displayName: "Assistant" }, "assistant");
  const as = (id: string, type: "user" | "agent" = "user") => t.as({ id, type, roles: type === "user" ? ["person"] : [] }, { tenant: org.id });
  const result: Org = {
    id: org.id,
    owner: as(who.owner),
    admin: as(who.admin),
    accountant: as(who.accountant),
    bookkeeper: as(who.bookkeeper),
    reviewer: as(who.reviewer),
    agent: as(agentId, "agent"),
    acct: {},
  };
  await result.owner.mutation(api.org.setup, { legalName: name, baseCurrency: "USD", fiscalYearStartMonth: 1, salesTaxRateBp: 800 });
  for (const a of await result.owner.query(api.accounts.list, {})) result.acct[a.number] = a.id;
  return result;
}

export async function withApp(fn: (t: TestApp) => Promise<void>) {
  const t = await createTestApp();
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

/** Assert the ledger's recomputed invariants hold. */
export async function assertIntegrity(org: Org) {
  const r = await org.owner.query(api.integrity.check, {});
  assert.deepEqual(r.problems, [], `integrity: ${r.problems.join("; ")}`);
  assert.equal(r.debitsMinor, r.creditsMinor);
}

export const dl = (accountId: string, amount: number, memo?: string) => ({ accountId, debit: amount, credit: 0, ...(memo ? { memo } : {}) });
export const cr = (accountId: string, amount: number, memo?: string) => ({ accountId, debit: 0, credit: amount, ...(memo ? { memo } : {}) });

export async function rejectsWith(p: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(p, (e: any) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (message) assert.match(e.message, message);
    return true;
  });
}

/** Seeded PRNG (mulberry32) for reproducible property tests. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]! };
}
