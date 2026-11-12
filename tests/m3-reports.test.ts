/**
 * M3 — reporting. A small month of business with hand-computed answers: every report must produce
 * exactly these numbers, derived only from posted ledger lines and documents.
 *
 *   2025-12-31  opening: bank 10,000.00 (Opening Balance Equity)
 *   2026-01-10  invoice 2,000.00 + 8% tax 160.00 = 2,160.00, due 2026-02-09
 *   2026-01-15  bill: office supplies 500.00, due 2026-02-14, unpaid
 *   2026-01-20  expense: software 300.00 paid from bank
 *   2026-01-25  laptop 1,200.00 from bank (fixed asset)
 *   2026-01-28  owner draw 400.00 from bank
 *   2026-02-01  customer pays 1,000.00 of the invoice
 *
 *   January P&L: revenue 2,000; expenses 800; net income 1,200
 *   Balance sheet 2026-01-31: bank 8,100 + AR 2,160 + equipment 1,200 = 11,460
 *     = AP 500 + tax 160 + (OBE 10,000 − draws 400 + current-year earnings 1,200)
 *   January cash flow: NI 1,200 − ΔAR 2,160 + ΔAP 500 + Δtax 160 = −300 operating; −1,200 investing;
 *     −400 financing; net −1,900 = actual change in cash
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../feltkit/_generated/api.js";
import { assertIntegrity, newOrg, withApp, type Org } from "./_helpers.js";

async function month(org: Org) {
  const A = org.acct;
  await org.accountant.mutation(api.accounts.setOpeningBalances, { date: "2025-12-31", balances: [{ accountId: A["1010"]!, balanceMinor: 1_000_000 }] });
  const customer = await org.bookkeeper.mutation(api.contacts.create, { kind: "customer", name: "Acme", paymentTermsDays: 30 });
  const vendor = await org.bookkeeper.mutation(api.contacts.create, { kind: "vendor", name: "Staples", paymentTermsDays: 30 });
  const [rate] = await org.reviewer.query(api.invoices.listTaxRates, {});
  const inv = await org.bookkeeper.mutation(api.invoices.create, { customerId: customer, issueDate: "2026-01-10", lines: [{ description: "Design sprint", quantityMilli: 1000, unitPriceMinor: 200_000, accountId: A["4000"]!, taxRateId: rate!.id }] });
  await org.bookkeeper.mutation(api.invoices.issue, { id: inv });
  const bill = await org.bookkeeper.mutation(api.bills.create, { vendorId: vendor, billNumber: "S-1", billDate: "2026-01-15", lines: [{ description: "Supplies", accountId: A["6300"]!, amountMinor: 50_000 }] });
  await org.accountant.mutation(api.bills.approve, { id: bill });
  await org.bookkeeper.mutation(api.bills.post, { id: bill });
  const exp = await org.bookkeeper.mutation(api.expenses.create, { date: "2026-01-20", description: "Figma", amountMinor: 30_000, expenseAccountId: A["6600"]!, paidFromAccountId: A["1010"]! });
  await org.accountant.mutation(api.expenses.approve, { id: exp });
  await org.accountant.mutation(api.journal.createAndPost, { date: "2026-01-25", description: "Laptop", lines: [{ accountId: A["1500"]!, debit: 120_000, credit: 0 }, { accountId: A["1010"]!, debit: 0, credit: 120_000 }] });
  await org.accountant.mutation(api.journal.createAndPost, { date: "2026-01-28", description: "Owner draw", lines: [{ accountId: A["3100"]!, debit: 40_000, credit: 0 }, { accountId: A["1010"]!, debit: 0, credit: 40_000 }] });
  await org.bookkeeper.mutation(api.payments.receive, { customerId: customer, date: "2026-02-01", amountMinor: 100_000, accountId: A["1010"]!, applyTo: [{ documentId: inv, amountMinor: 100_000 }] });
  // A draft that must not appear anywhere.
  await org.bookkeeper.mutation(api.journal.createDraft, { date: "2026-01-30", description: "Draft accrual", lines: [{ accountId: A["6500"]!, debit: 999_999, credit: 0 }, { accountId: A["2500"]!, debit: 0, credit: 999_999 }] });
  return { customer, vendor, inv, bill };
}

test("profit and loss, balance sheet, cash flow and trial balance match the hand-computed answers", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    await month(org);
    const pl = await org.reviewer.query(api.reports.profitAndLoss, { from: "2026-01-01", to: "2026-01-31" });
    assert.deepEqual([pl.totalRevenueMinor, pl.totalExpensesMinor, pl.netIncomeMinor], [200_000, 80_000, 120_000]);
    assert.deepEqual(pl.expenses.map((r) => [r.number, r.amountMinor]), [["6300", 50_000], ["6600", 30_000]]);

    const bs = await org.reviewer.query(api.reports.balanceSheet, { asOf: "2026-01-31" });
    assert.equal(bs.totalAssetsMinor, 1_146_000);
    assert.deepEqual(Object.fromEntries(bs.assets.map((r) => [r.number, r.amountMinor])), { "1010": 810_000, "1100": 216_000, "1500": 120_000 });
    assert.deepEqual(Object.fromEntries(bs.liabilities.map((r) => [r.number, r.amountMinor])), { "2000": 50_000, "2200": 16_000 });
    assert.deepEqual(Object.fromEntries(bs.equity.map((r) => [r.number, r.amountMinor])), { "3100": -40_000, "3900": 1_000_000 });
    assert.equal(bs.currentYearEarningsMinor, 120_000);
    assert.equal(bs.retainedEarningsPriorYearsMinor, 0);
    assert.equal(bs.balanced, true);

    const cf = await org.reviewer.query(api.reports.cashFlow, { from: "2026-01-01", to: "2026-01-31" });
    assert.deepEqual([cf.netIncomeMinor, cf.operatingMinor, cf.investingMinor, cf.financingMinor, cf.netChangeMinor], [120_000, -30_000, -120_000, -40_000, -190_000]);
    assert.deepEqual([cf.openingCashMinor, cf.closingCashMinor], [1_000_000, 810_000]);
    assert.equal(cf.reconciles, true);

    const tb = await org.reviewer.query(api.reports.trialBalance, { asOf: "2026-01-31" });
    assert.equal(tb.balanced, true);
    // Debit balances: bank 810,000 + AR 216,000 + equipment 120,000 + supplies 50,000 + software 30,000 + draws 40,000.
    // Credit balances: AP 50,000 + tax 16,000 + revenue 200,000 + opening equity 1,000,000.
    assert.equal(tb.totalDebitMinor, 1_266_000);
    assert.equal(tb.totalCreditMinor, 1_266_000);

    // The general ledger and every account history agree with the balance sheet.
    const gl = await org.reviewer.query(api.reports.generalLedger, { from: "2026-01-01", to: "2026-01-31" });
    const bank = gl.accounts.find((x) => x.number === "1010")!;
    assert.deepEqual([bank.openingMinor, bank.closingMinor, bank.rows.length], [1_000_000, 810_000, 3]);
    for (const row of bs.assets) {
      const h = await org.reviewer.query(api.accounts.history, { accountId: row.accountId, to: "2026-01-31" });
      assert.equal(h.closingBalanceMinor, row.amountMinor, `history of ${row.number}`);
    }
    await assertIntegrity(org);
  }));

test("aging buckets, overview figures, and the next fiscal year's retained earnings", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const { inv, bill } = await month(org);
    const ar = await org.reviewer.query(api.reports.arAging, { asOf: "2026-03-15" });
    assert.equal(ar.totalMinor, 116_000);
    assert.deepEqual(ar.items.map((i) => [i.id, i.bucket]), [[inv, "31-60"]]);
    const ap = await org.reviewer.query(api.reports.apAging, { asOf: "2026-03-15" });
    assert.deepEqual(ap.items.map((i) => [i.id, i.bucket, i.balanceMinor]), [[bill, "1-30", 50_000]]);
    assert.equal((await org.reviewer.query(api.reports.arAging, { asOf: "2026-01-05" })).totalMinor, 0, "before the invoice was issued");

    const o = await org.reviewer.query(api.overview.get, { asOf: "2026-02-10" });
    assert.equal(o.cash.totalMinor, 910_000);
    assert.equal(o.receivables.totalMinor, 116_000);
    assert.equal(o.receivables.overdueMinor, 116_000);
    assert.equal(o.payables.totalMinor, 50_000);
    assert.equal(o.yearToDate.netIncomeMinor, 120_000);
    assert.equal(o.outstandingInvoices[0]!.id, inv);
    assert.equal(o.upcomingBills[0]!.id, bill);

    const next = await org.reviewer.query(api.reports.balanceSheet, { asOf: "2027-01-31" });
    assert.equal(next.retainedEarningsPriorYearsMinor, 120_000);
    assert.equal(next.currentYearEarningsMinor, 0);
    assert.equal(next.balanced, true);

    const ex = await org.reviewer.query(api.reports.explainChange, { fromA: "2025-12-01", toA: "2025-12-31", fromB: "2026-01-01", toB: "2026-01-31" });
    assert.equal(ex.netIncomeChangeMinor, 120_000);
    assert.equal(ex.changes[0]!.number, "4000");
    assert.ok(ex.changes[0]!.largestEntriesInB.length > 0, "each change links to the entries behind it");
    await assertIntegrity(org);
  }));

test("the audit trail records who did what, in order, with the request that did it", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const { inv } = await month(org);
    const events = await org.reviewer.query(api.activity.list, { subjectType: "invoice", subjectId: inv });
    assert.deepEqual(events.map((e) => e.type).reverse(), ["invoice.drafted", "invoice.issued", "invoice.payment.applied"]);
    assert.deepEqual(events.map((e) => e.actor).reverse(), ["grace", "grace", "grace"]);
    assert.ok(events.every((e) => e.requestId));
    const issued = events.find((e) => e.type === "invoice.issued")!;
    const [logged] = await t.runtime.activity.list({ requestId: issued.requestId });
    assert.equal(logged!.name, "invoices:issue", "the audit event links to FeltKit's activity log entry");
    assert.equal(logged!.outcome, "success");
    assert.ok(logged!.writes!.length > 0);
    // Subledger integrity: AR and AP equal their open documents.
    await assertIntegrity(org);
  }));
