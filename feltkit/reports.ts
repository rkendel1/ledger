/**
 * Financial reports. Every number is computed on request from posted `ledgerLines` (and, for aging,
 * from documents and allocations). Nothing here is stored, so a report can never disagree with the
 * ledger it summarizes. Each row carries the account id so the UI can drill into the account history.
 */
import { fail, s, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { accounts, app, contacts, ledgerLines } from "./app.js";
import { report } from "./_contracts.js";
import { normalBalance, requireDate, requireSettings, today } from "./_ledger.js";
import { bucket, openBills, openInvoices } from "./_documents.js";

type Ctx = QueryCtx | MutationCtx;
type Account = Awaited<ReturnType<typeof loadAccounts>>[number];

async function loadAccounts(ctx: Ctx) {
  return ctx.db.find(accounts, {}, { orderBy: [{ field: "number", direction: "asc" }] });
}

/** Debit and credit totals per account over lines with from ≤ date ≤ to (either bound optional). */
export async function totalsByAccount(ctx: Ctx, range: { from?: string; to?: string }) {
  const out = new Map<string, { debit: number; credit: number }>();
  for (const l of await ctx.db.find(ledgerLines, {})) {
    if (range.from && l.date < range.from) continue;
    if (range.to && l.date > range.to) continue;
    const t = out.get(l.accountId) ?? { debit: 0, credit: 0 };
    t.debit += l.debit;
    t.credit += l.credit;
    out.set(l.accountId, t);
  }
  return out;
}

/** The first day of the fiscal year containing `day`. */
export function fiscalYearStart(day: string, startMonth: number): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const y = month >= startMonth ? year : year - 1;
  return `${y}-${String(startMonth).padStart(2, "0")}-01`;
}

function dayBefore(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const row = (a: Account, amount: number) => ({ accountId: a.id, number: a.number, name: a.name, subtype: a.subtype, amountMinor: amount });

function netIncomeOf(accs: Account[], totals: Map<string, { debit: number; credit: number }>) {
  let net = 0;
  for (const a of accs) {
    const t = totals.get(a.id);
    if (!t) continue;
    if (a.type === "revenue") net += t.credit - t.debit;
    if (a.type === "expense") net -= t.debit - t.credit;
  }
  return net;
}

export async function trialBalanceData(ctx: Ctx, asOf: string, from?: string) {
  const accs = await loadAccounts(ctx);
  const totals = await totalsByAccount(ctx, { to: asOf, ...(from ? { from } : {}) });
  const rows = accs
    .filter((a) => totals.has(a.id))
    .map((a) => {
      const t = totals.get(a.id)!;
      const net = t.debit - t.credit;
      return { accountId: a.id, number: a.number, name: a.name, type: a.type, debitMinor: net > 0 ? net : 0, creditMinor: net < 0 ? -net : 0 };
    })
    .filter((r) => r.debitMinor !== 0 || r.creditMinor !== 0);
  const totalDebitMinor = rows.reduce((t, r) => t + r.debitMinor, 0);
  const totalCreditMinor = rows.reduce((t, r) => t + r.creditMinor, 0);
  return { asOf, rows, totalDebitMinor, totalCreditMinor, balanced: totalDebitMinor === totalCreditMinor };
}

export const trialBalance = app.query({
  access: "reports.read",
  args: { asOf: s.optional(s.string()), from: s.optional(s.string()) },
  returns: report<Awaited<ReturnType<typeof trialBalanceData>>>(),
  capability: { name: "reports.trialbalance", description: "Trial balance: net debit or credit per account through a date." },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const asOf = requireDate(a.asOf ?? today(), "asOf");
    return trialBalanceData(ctx, asOf, a.from);
  },
});

export async function profitAndLossData(ctx: Ctx, from: string, to: string) {
  const accs = await loadAccounts(ctx);
  const totals = await totalsByAccount(ctx, { from, to });
  const pick = (pred: (a: Account) => boolean) =>
    accs.filter((a) => pred(a) && totals.has(a.id)).map((a) => {
      const t = totals.get(a.id)!;
      return row(a, normalBalance(a.type, t.debit, t.credit));
    }).filter((r) => r.amountMinor !== 0);
  const revenue = pick((a) => a.type === "revenue" && a.subtype === "revenue");
  const otherIncome = pick((a) => a.type === "revenue" && a.subtype !== "revenue");
  const costOfSales = pick((a) => a.type === "expense" && a.subtype === "cost_of_sales");
  const expenses = pick((a) => a.type === "expense" && a.subtype !== "cost_of_sales");
  const sum = (rs: { amountMinor: number }[]) => rs.reduce((t, r) => t + r.amountMinor, 0);
  const totalRevenueMinor = sum(revenue);
  const grossProfitMinor = totalRevenueMinor - sum(costOfSales);
  const netIncomeMinor = grossProfitMinor + sum(otherIncome) - sum(expenses);
  return {
    from, to, revenue, costOfSales, otherIncome, expenses,
    totalRevenueMinor, totalCostOfSalesMinor: sum(costOfSales), grossProfitMinor,
    totalOtherIncomeMinor: sum(otherIncome), totalExpensesMinor: sum(expenses), netIncomeMinor,
  };
}

export const profitAndLoss = app.query({
  access: "reports.read",
  args: { from: s.string(), to: s.string() },
  returns: report<Awaited<ReturnType<typeof profitAndLossData>>>(),
  capability: { name: "reports.profitandloss", description: "Profit and loss for a date range." },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    requireDate(a.from, "from");
    requireDate(a.to, "to");
    if (a.from > a.to) fail("INVALID_ARGUMENT", "from must be on or before to.");
    return profitAndLossData(ctx, a.from, a.to);
  },
});

export async function balanceSheetData(ctx: Ctx, asOf: string) {
  const settings = await requireSettings(ctx);
  const accs = await loadAccounts(ctx);
  const totals = await totalsByAccount(ctx, { to: asOf });
  const fyStart = fiscalYearStart(asOf, settings.fiscalYearStartMonth);
  const section = (type: string) =>
    accs.filter((a) => a.type === type && totals.has(a.id)).map((a) => {
      const t = totals.get(a.id)!;
      return row(a, normalBalance(a.type, t.debit, t.credit));
    }).filter((r) => r.amountMinor !== 0);
  const assets = section("asset");
  const liabilities = section("liability");
  const equity = section("equity");
  const priorYears = netIncomeOf(accs, await totalsByAccount(ctx, { to: dayBefore(fyStart) }));
  const currentYear = netIncomeOf(accs, await totalsByAccount(ctx, { from: fyStart, to: asOf }));
  const sum = (rs: { amountMinor: number }[]) => rs.reduce((t, r) => t + r.amountMinor, 0);
  const totalAssetsMinor = sum(assets);
  const totalLiabilitiesMinor = sum(liabilities);
  const totalEquityMinor = sum(equity) + priorYears + currentYear;
  return {
    asOf, fiscalYearStart: fyStart,
    assets, liabilities, equity,
    retainedEarningsPriorYearsMinor: priorYears,
    currentYearEarningsMinor: currentYear,
    totalAssetsMinor, totalLiabilitiesMinor, totalEquityMinor,
    totalLiabilitiesAndEquityMinor: totalLiabilitiesMinor + totalEquityMinor,
    balanced: totalAssetsMinor === totalLiabilitiesMinor + totalEquityMinor,
  };
}

export const balanceSheet = app.query({
  access: "reports.read",
  args: { asOf: s.optional(s.string()) },
  returns: report<Awaited<ReturnType<typeof balanceSheetData>>>(),
  capability: { name: "reports.balancesheet", description: "Balance sheet as of a date, with a check that it balances." },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    return balanceSheetData(ctx, requireDate(a.asOf ?? today(), "asOf"));
  },
});

const OPERATING = new Set(["receivable", "other_current_asset", "payable", "credit_card", "tax_payable", "other_current_liability"]);
const INVESTING = new Set(["fixed_asset"]);
const CASH = new Set(["cash", "bank"]);

/**
 * Cash flow (indirect method): net income, adjusted by the change in each working-capital account,
 * then investing (fixed assets) and financing (long-term liabilities, equity). The sum is checked
 * against the actual change in cash and bank accounts.
 */
export async function cashFlowData(ctx: Ctx, from: string, to: string) {
  const accs = await loadAccounts(ctx);
  const period = await totalsByAccount(ctx, { from, to });
  const before = await totalsByAccount(ctx, { to: dayBefore(from) });
  const netIncomeMinor = netIncomeOf(accs, period);
  const operating: ReturnType<typeof row>[] = [];
  const investing: ReturnType<typeof row>[] = [];
  const financing: ReturnType<typeof row>[] = [];
  let cashChange = 0;
  let openingCash = 0;
  for (const a of accs) {
    const t = period.get(a.id) ?? { debit: 0, credit: 0 };
    if (CASH.has(a.subtype)) {
      cashChange += t.debit - t.credit;
      const b = before.get(a.id);
      if (b) openingCash += b.debit - b.credit;
      continue;
    }
    if (a.type === "revenue" || a.type === "expense") continue;
    // Cash effect of a balance-sheet account: an increase in an asset uses cash; in a liability or equity, provides it.
    const effect = t.credit - t.debit;
    if (effect === 0) continue;
    if (OPERATING.has(a.subtype)) operating.push(row(a, effect));
    else if (INVESTING.has(a.subtype)) investing.push(row(a, effect));
    else financing.push(row(a, effect));
  }
  const sum = (rs: { amountMinor: number }[]) => rs.reduce((t, r) => t + r.amountMinor, 0);
  const operatingMinor = netIncomeMinor + sum(operating);
  const investingMinor = sum(investing);
  const financingMinor = sum(financing);
  const netChangeMinor = operatingMinor + investingMinor + financingMinor;
  return {
    from, to, netIncomeMinor, operatingAdjustments: operating, investing, financing,
    operatingMinor, investingMinor, financingMinor, netChangeMinor,
    openingCashMinor: openingCash, closingCashMinor: openingCash + cashChange, actualCashChangeMinor: cashChange,
    reconciles: netChangeMinor === cashChange,
  };
}

export const cashFlow = app.query({
  access: "reports.read",
  args: { from: s.string(), to: s.string() },
  returns: report<Awaited<ReturnType<typeof cashFlowData>>>(),
  capability: { name: "reports.cashflow", description: "Cash flow statement (indirect method) for a date range." },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    requireDate(a.from, "from");
    requireDate(a.to, "to");
    if (a.from > a.to) fail("INVALID_ARGUMENT", "from must be on or before to.");
    return cashFlowData(ctx, a.from, a.to);
  },
});

/** Every account with activity in the range: opening balance, its lines, closing balance. */
export const generalLedger = app.query({
  access: "reports.read",
  args: { from: s.string(), to: s.string() },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    requireDate(a.from, "from");
    requireDate(a.to, "to");
    const accs = await loadAccounts(ctx);
    const lines = (await ctx.db.find(ledgerLines, {})).sort((x, y) => (x.date === y.date ? x.entryNumber - y.entryNumber || x.lineNo - y.lineNo : x.date < y.date ? -1 : 1));
    const out = [];
    for (const acc of accs) {
      const mine = lines.filter((l) => l.accountId === acc.id && l.date <= a.to);
      let balance = 0;
      for (const l of mine) if (l.date < a.from) balance += normalBalance(acc.type, l.debit, l.credit);
      const opening = balance;
      const rows = mine.filter((l) => l.date >= a.from).map((l) => {
        balance += normalBalance(acc.type, l.debit, l.credit);
        return { lineId: l.id, entryId: l.entryId, entryNumber: l.entryNumber, date: l.date, memo: l.memo ?? "", debit: l.debit, credit: l.credit, balance };
      });
      if (rows.length || opening) out.push({ accountId: acc.id, number: acc.number, name: acc.name, type: acc.type, openingMinor: opening, closingMinor: balance, rows });
    }
    return { from: a.from, to: a.to, accounts: out };
  },
});

async function contactNames(ctx: Ctx) {
  return new Map((await ctx.db.find(contacts, {})).map((c) => [c.id, c.name]));
}

const BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;

function aging<T extends { id: string; dueDate: string; balanceMinor: number }>(docs: T[], asOf: string, contactOf: (d: T) => string, names: Map<string, string>, label: (d: T) => string) {
  const byContact = new Map<string, Record<string, number> & { total: number }>();
  const items = docs.map((d) => {
    const b = bucket(d.dueDate, asOf);
    const c = contactOf(d);
    const r = byContact.get(c) ?? Object.assign(Object.fromEntries(BUCKETS.map((k) => [k, 0])), { total: 0 });
    r[b] = (r[b] ?? 0) + d.balanceMinor;
    r.total += d.balanceMinor;
    byContact.set(c, r);
    return { id: d.id, label: label(d), contactId: c, contactName: names.get(c) ?? "?", dueDate: d.dueDate, bucket: b, balanceMinor: d.balanceMinor };
  });
  const totals = Object.fromEntries(BUCKETS.map((k) => [k, items.filter((i) => i.bucket === k).reduce((t, i) => t + i.balanceMinor, 0)]));
  return {
    asOf, buckets: BUCKETS,
    contacts: [...byContact.entries()].map(([id, r]) => ({ contactId: id, name: names.get(id) ?? "?", ...r })).sort((x, y) => y.total - x.total),
    items, totals, totalMinor: items.reduce((t, i) => t + i.balanceMinor, 0),
  };
}

export async function arAgingData(ctx: Ctx, asOf: string) {
  return aging(await openInvoices(ctx, asOf), asOf, (d) => d.customerId, await contactNames(ctx), (d) => d.number ?? "(draft)");
}

export async function apAgingData(ctx: Ctx, asOf: string) {
  return aging(await openBills(ctx, asOf), asOf, (d) => d.vendorId, await contactNames(ctx), (d) => d.billNumber);
}

export const arAging = app.query({
  access: "reports.read",
  args: { asOf: s.optional(s.string()) },
  returns: report<Awaited<ReturnType<typeof arAgingData>>>(),
  capability: { name: "reports.araging", description: "Accounts receivable aging by customer." },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const asOf = requireDate(a.asOf ?? today(), "asOf");
    return arAgingData(ctx, asOf);
  },
});

export const apAging = app.query({
  access: "reports.read",
  args: { asOf: s.optional(s.string()) },
  returns: report<Awaited<ReturnType<typeof apAgingData>>>(),
  capability: { name: "reports.apaging", description: "Accounts payable aging by vendor." },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const asOf = requireDate(a.asOf ?? today(), "asOf");
    return apAgingData(ctx, asOf);
  },
});

export async function explainChangeData(ctx: Ctx, a: { fromA: string; toA: string; fromB: string; toB: string }) {
  for (const d of [a.fromA, a.toA, a.fromB, a.toB]) requireDate(d);
  const accs = await loadAccounts(ctx);
  const tA = await totalsByAccount(ctx, { from: a.fromA, to: a.toA });
  const tB = await totalsByAccount(ctx, { from: a.fromB, to: a.toB });
  const lines = await ctx.db.find(ledgerLines, {});
  const changes = accs.filter((x) => x.type === "revenue" || x.type === "expense").map((x) => {
    const va = tA.get(x.id) ? normalBalance(x.type, tA.get(x.id)!.debit, tA.get(x.id)!.credit) : 0;
    const vb = tB.get(x.id) ? normalBalance(x.type, tB.get(x.id)!.debit, tB.get(x.id)!.credit) : 0;
    // Effect on net income: revenue up is good, expense up is bad.
    const effect = x.type === "revenue" ? vb - va : va - vb;
    const entries = lines.filter((l) => l.accountId === x.id && l.date >= a.fromB && l.date <= a.toB)
      .sort((p, q) => (q.debit + q.credit) - (p.debit + p.credit)).slice(0, 5)
      .map((l) => ({ entryId: l.entryId, entryNumber: l.entryNumber, date: l.date, memo: l.memo ?? "", amountMinor: l.debit + l.credit }));
    return { accountId: x.id, number: x.number, name: x.name, type: x.type, periodAMinor: va, periodBMinor: vb, changeMinor: vb - va, netIncomeEffectMinor: effect, largestEntriesInB: entries };
  }).filter((c) => c.changeMinor !== 0).sort((p, q) => Math.abs(q.changeMinor) - Math.abs(p.changeMinor));
  const netA = netIncomeOf(accs, tA);
  const netB = netIncomeOf(accs, tB);
  const summary = changes.slice(0, 3).map((c) => `${c.name} ${c.changeMinor > 0 ? "rose" : "fell"} by ${(Math.abs(c.changeMinor) / 100).toFixed(2)}`).join("; ");
  return { netIncomeAMinor: netA, netIncomeBMinor: netB, netIncomeChangeMinor: netB - netA, summary: summary || "No revenue or expense changed.", changes };
}

/**
 * Explain what changed between two periods' profit and loss: the accounts that moved the most, and
 * the entries behind each movement. Deterministic; no model involved.
 */
export const explainChange = app.query({
  access: "reports.read",
  args: { fromA: s.string(), toA: s.string(), fromB: s.string(), toB: s.string() },
  returns: report<Awaited<ReturnType<typeof explainChangeData>>>(),
  capability: { name: "reports.explainchange", description: "Compare two periods' profit and loss and list the accounts and entries behind the change." },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    return explainChangeData(ctx, a);
  },
});
