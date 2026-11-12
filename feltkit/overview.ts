/**
 * The landing dashboard. Every figure is computed from the ledger and documents on request and comes
 * with the record ids behind it, so the UI can link each number to its support.
 */
import { s } from "@feltdb/feltkit";
import { accounts, app, bankAccounts, journalEntries, reconciliations, bankTransactions } from "./app.js";
import { addDays, normalBalance, requireDate, requireSettings, today } from "./_ledger.js";
import { openBills, openInvoices } from "./_documents.js";
import { fiscalYearStart, profitAndLossData, totalsByAccount } from "./reports.js";

export const get = app.query({
  access: "reports.read",
  args: { asOf: s.optional(s.string()) },
  handler: async (ctx, a) => {
    const settings = await requireSettings(ctx);
    const asOf = requireDate(a.asOf ?? today(), "asOf");
    const fyStart = fiscalYearStart(asOf, settings.fiscalYearStartMonth);
    const accs = await ctx.db.find(accounts, {});
    const totals = await totalsByAccount(ctx, { to: asOf });
    const cash = accs.filter((x) => x.subtype === "cash" || x.subtype === "bank").map((x) => {
      const t = totals.get(x.id) ?? { debit: 0, credit: 0 };
      return { accountId: x.id, number: x.number, name: x.name, balanceMinor: normalBalance(x.type, t.debit, t.credit) };
    });
    const invoices = await openInvoices(ctx, asOf);
    const bills = await openBills(ctx, asOf);
    const pl = await profitAndLossData(ctx, fyStart, asOf);
    const recent = (await ctx.db.find(journalEntries, { status: "posted" }))
      .sort((x, y) => y.number - x.number).slice(0, 8)
      .map((e) => ({ id: e.id, number: e.number, date: e.date, description: e.description, totalMinor: e.totalMinor, sourceType: e.sourceType }));
    const banks = [];
    for (const b of await ctx.db.find(bankAccounts, {})) {
      const recs = (await ctx.db.find(reconciliations, { bankAccountId: b.id })).filter((r) => r.status === "completed").sort((x, y) => (x.statementEnd < y.statementEnd ? 1 : -1));
      banks.push({ id: b.id, name: b.name, lastReconciledThrough: recs[0]?.statementEnd ?? null, unmatchedCount: await ctx.db.count(bankTransactions, { bankAccountId: b.id, status: "unmatched" }) });
    }
    const soon = addDays(asOf, 14);
    return {
      asOf, fiscalYearStart: fyStart, currency: settings.baseCurrency, organization: settings.displayName,
      cash: { totalMinor: cash.reduce((t, c) => t + c.balanceMinor, 0), accounts: cash },
      receivables: { totalMinor: invoices.reduce((t, i) => t + i.balanceMinor, 0), overdueMinor: invoices.filter((i) => i.dueDate < asOf).reduce((t, i) => t + i.balanceMinor, 0), count: invoices.length },
      payables: { totalMinor: bills.reduce((t, b) => t + b.balanceMinor, 0), overdueMinor: bills.filter((b) => b.dueDate < asOf).reduce((t, b) => t + b.balanceMinor, 0), count: bills.length },
      yearToDate: { revenueMinor: pl.totalRevenueMinor + pl.totalOtherIncomeMinor, expensesMinor: pl.totalCostOfSalesMinor + pl.totalExpensesMinor, netIncomeMinor: pl.netIncomeMinor },
      outstandingInvoices: invoices.sort((x, y) => (x.dueDate < y.dueDate ? -1 : 1)).slice(0, 6).map((i) => ({ id: i.id, number: i.number ?? "", customerId: i.customerId, dueDate: i.dueDate, balanceMinor: i.balanceMinor, overdue: i.dueDate < asOf })),
      upcomingBills: bills.filter((b) => b.dueDate <= soon).sort((x, y) => (x.dueDate < y.dueDate ? -1 : 1)).slice(0, 6).map((b) => ({ id: b.id, billNumber: b.billNumber, vendorId: b.vendorId, dueDate: b.dueDate, balanceMinor: b.balanceMinor, overdue: b.dueDate < asOf })),
      recent,
      banks,
    };
  },
});
