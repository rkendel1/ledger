/**
 * Ledger as an AppBoundry artifact (`feltkit build --target appboundry` → ledger.app), run in
 * FeltKit's reference guest host with organizations (tenancy@1). The same calls as the Node tests,
 * the same answers: an organization is created, members are provisioned by an operator (an AppBoundry
 * host has no e-mailed invitations), and the core bookkeeping workflows run inside it; another
 * organization sees none of it; an agent member proposes but cannot execute.
 *
 * Before tenancy@1 (GAP-REGISTER G-05) this file could only show that every organization-scoped call
 * was closed. Run with `npm run test:artifact` (builds first).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createArtifactTestApp, type ArtifactTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";

const person = (id: string) => ({ id, type: "user" as const, roles: ["person"] });

async function organization(t: ArtifactTestApp, name: string, people: { owner: string; accountant: string; bookkeeper: string; reviewer: string }) {
  const created = (await t.tenancy.call("create", { name }, person(people.owner))) as { id: string };
  for (const role of ["accountant", "bookkeeper", "reviewer"] as const) {
    await t.tenancy.provision({ tenantId: created.id, principal: { id: people[role], type: "user" }, role });
  }
  const agentId = `assistant-${created.id.slice(-6)}`;
  await t.tenancy.provision({ tenantId: created.id, principal: { id: agentId, type: "agent" }, role: "assistant" });
  const as = (id: string, type: "user" | "agent" = "user") => t.as({ id, type, roles: type === "user" ? ["person"] : [] }, { tenant: created.id });
  const org = { id: created.id, owner: as(people.owner), accountant: as(people.accountant), bookkeeper: as(people.bookkeeper), reviewer: as(people.reviewer), agent: as(agentId, "agent"), acct: {} as Record<string, string> };
  await org.owner.mutation(api.org.setup, { legalName: name, baseCurrency: "USD", fiscalYearStartMonth: 1, salesTaxRateBp: 800 });
  for (const a of await org.owner.query(api.accounts.list, {})) org.acct[a.number] = a.id;
  return org;
}

test("Ledger runs on AppBoundry: organizations, invoicing, payments, expenses with receipts, banking, journal, reports, isolation", { timeout: 600_000 }, async () => {
  assert.ok(existsSync("ledger.app"), "build it first: npx feltkit build --target appboundry");
  const t = await createArtifactTestApp("ledger.app");
  try {
    assert.equal(t.host.manifest.runtime.interfaces.tenancy, 1, "the artifact requires tenancy@1");
    const a = await organization(t, "Acme", { owner: "ada", accountant: "ana", bookkeeper: "grace", reviewer: "rita" });
    const b = await organization(t, "Globex", { owner: "gus", accountant: "gil", bookkeeper: "gwen", reviewer: "gabe" });
    const me = await a.bookkeeper.query(api.org.me, {});
    assert.equal(me.tenant?.id, a.id);
    assert.ok(me.permissions.includes("invoices.issue"));

    // Invoicing and a payment.
    const customer = await a.bookkeeper.mutation(api.contacts.create, { kind: "customer", name: "Northwind" });
    const inv = await a.bookkeeper.mutation(api.invoices.create, { customerId: customer, issueDate: "2026-03-01", lines: [{ description: "Work", quantityMilli: 1000, unitPriceMinor: 100000, accountId: a.acct["4000"]! }] });
    await a.bookkeeper.mutation(api.invoices.issue, { id: inv });
    await a.bookkeeper.mutation(api.payments.receive, { customerId: customer, date: "2026-03-05", amountMinor: 50000, accountId: a.acct["1010"]!, applyTo: [{ documentId: inv, amountMinor: 50000 }] });

    // An expense with a receipt (Files, in this organization).
    const exp = await a.bookkeeper.mutation(api.expenses.create, { date: "2026-03-02", description: "Lunch", amountMinor: 2500, expenseAccountId: a.acct["6200"]!, paidFromAccountId: a.acct["1010"]! });
    const receiptId = await a.bookkeeper.mutation(api.expenses.upload, { subjectType: "expense", subjectId: exp, name: "r.txt", contentBase64: Buffer.from("receipt bytes").toString("base64") });
    const read = (await a.reviewer.query(api.expenses.readReceipt, { receiptId })) as { contentBase64?: string } | string;
    assert.match(JSON.stringify(read), /cmVjZWlwdCBieXRlcw|receipt bytes/);

    // A bank import and a categorization.
    const bank = await a.accountant.mutation(api.banking.createAccount, { name: "Checking", accountId: a.acct["1010"]! });
    await a.bookkeeper.mutation(api.banking.importStatement, { bankAccountId: bank, fileName: "q1.csv", csv: "Date,Description,Amount\n2026-03-09,STAPLES STORE 22,-48.10\n" });
    const [txn] = await a.reviewer.query(api.banking.transactions, { bankAccountId: bank });
    await a.bookkeeper.mutation(api.banking.categorize, { bankTransactionId: txn!.id, splits: [{ accountId: a.acct["6300"]!, amountMinor: 4810 }] });

    // A manual journal by the accountant; a bookkeeper may not post one.
    const lines = [{ accountId: a.acct["6900"]!, debit: 1000, credit: 0 }, { accountId: a.acct["1010"]!, debit: 0, credit: 1000 }];
    await assert.rejects(a.bookkeeper.mutation(api.journal.createAndPost, { date: "2026-03-10", description: "Fee", lines }), { code: "FORBIDDEN" });
    await a.accountant.mutation(api.journal.createAndPost, { date: "2026-03-10", description: "Fee", lines });

    // Reports from the posted lines, and the integrity check.
    const tb = await a.reviewer.query(api.reports.trialBalance, {});
    assert.ok(tb.balanced);
    const pl = await a.reviewer.query(api.reports.profitAndLoss, { from: "2026-01-01", to: "2026-12-31" });
    assert.ok(JSON.stringify(pl).includes("100000"), "revenue of 1,000.00 is in the P&L");
    const integrity = await a.owner.query(api.integrity.check, {});
    assert.deepEqual(integrity.problems, []);

    // Isolation: Globex sees none of Acme's books or files.
    assert.equal((await b.reviewer.query(api.invoices.list, {})).length, 0);
    await assert.rejects(b.owner.query(api.expenses.readReceipt, { receiptId }), { code: "NOT_FOUND" });
    assert.equal((await b.reviewer.query(api.journal.list, {})).length, 0);
    await assert.rejects(b.bookkeeper.mutation(api.invoices.issue, { id: inv }), (e: { code: string }) => ["NOT_FOUND", "FAILED_PRECONDITION"].includes(e.code));

    // The agent member reads and proposes; it cannot execute (Ledger's person-only rule, and FeltKit's).
    assert.ok((await a.agent.query(api.reports.trialBalance, {})).balanced);
    await assert.rejects(a.agent.mutation(api.invoices.issue, { id: inv }), { code: "FORBIDDEN" });

    // A member removed by the owner loses the organization on the next call.
    await t.tenancy.call("remove", { principalId: "rita" }, person("ada"), { tenant: a.id });
    await assert.rejects(a.reviewer.query(api.reports.trialBalance, {}), (e: { code: string }) => ["FORBIDDEN", "FAILED_PRECONDITION"].includes(e.code));
  } finally {
    await t.close();
  }
});
