/**
 * Reconciliation: prove that a bank statement and the books agree for a period.
 *
 * A session names the statement's date range and closing balance. The opening balance is the previous
 * completed reconciliation's closing balance (or, for the first one, the statement's opening balance).
 * The workspace shows, live:
 *   - statement check:  opening + every imported transaction in range = closing? (else rows are missing)
 *   - unmatched transactions: on the statement, not yet in the books
 *   - outstanding items: in the books (on the bank's account), not yet on a statement
 *   - difference: closing − (opening + matched transactions)
 * Completing requires no unmatched transactions and a statement that adds up. It stamps every
 * transaction with the reconciliation and stores the evidence; those transactions can no longer be
 * unmatched.
 */
import { fail, s, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { app, audit, bankMatches, bankTransactions, journalEntries, ledgerLines, reconciliations } from "./app.js";
import { actor, addDays, requireDate, requireSettings, requirePerson } from "./_ledger.js";
import { requireBankAccount } from "./_bank.js";

type Ctx = QueryCtx | MutationCtx;

export const start = app.mutation({
  access: "banking.match",
  args: {
    bankAccountId: s.string(),
    statementEnd: s.string(),
    closingBalanceMinor: s.integer(),
    /** Only for the first reconciliation of an account: the statement's opening balance and start date. */
    openingBalanceMinor: s.optional(s.integer()),
    statementStart: s.optional(s.string()),
  },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const ba = await requireBankAccount(ctx, a.bankAccountId);
    const recs = await ctx.db.find(reconciliations, { bankAccountId: ba.id });
    if (recs.some((r) => r.status === "in_progress")) fail("FAILED_PRECONDITION", "Finish the reconciliation in progress first.");
    const last = recs.filter((r) => r.status === "completed").sort((x, y) => (x.statementEnd < y.statementEnd ? 1 : -1))[0];
    let statementStart: string;
    let opening: number;
    if (last) {
      statementStart = addDays(last.statementEnd, 1);
      opening = last.closingBalanceMinor;
      if (a.openingBalanceMinor !== undefined && a.openingBalanceMinor !== opening) {
        fail("FAILED_PRECONDITION", `The statement's opening balance (${a.openingBalanceMinor}) differs from the last reconciled closing balance (${opening}).`);
      }
    } else {
      if (a.openingBalanceMinor === undefined || !a.statementStart) fail("INVALID_ARGUMENT", "The first reconciliation needs the statement's start date and opening balance.");
      statementStart = requireDate(a.statementStart, "statementStart");
      opening = a.openingBalanceMinor;
    }
    const statementEnd = requireDate(a.statementEnd, "statementEnd");
    if (statementEnd < statementStart) fail("INVALID_ARGUMENT", `The statement must end on or after ${statementStart}.`);
    const id = await ctx.db.insert(reconciliations, {
      bankAccountId: ba.id, statementStart, statementEnd, openingBalanceMinor: opening, closingBalanceMinor: a.closingBalanceMinor,
      status: "in_progress", startedBy: actor(ctx), startedAt: Date.now(),
    });
    await audit.record(ctx, { subject: "reconciliation", id, type: "reconciliation.started", data: { bankAccountId: ba.id, statementStart, statementEnd, openingBalanceMinor: opening, closingBalanceMinor: a.closingBalanceMinor } });
    return id;
  },
});

/** The live state of a reconciliation (for an in-progress one) or its evidence (completed). */
export async function workspace(ctx: Ctx, id: string) {
  const rec = await ctx.db.get(reconciliations, id);
  if (!rec) fail("NOT_FOUND", "No such reconciliation.");
  const ba = await requireBankAccount(ctx, rec.bankAccountId);
  const all = await ctx.db.find(bankTransactions, { bankAccountId: ba.id });
  const inRange = all.filter((t) => t.date >= rec.statementStart && t.date <= rec.statementEnd);
  const counted = inRange.filter((t) => t.status !== "excluded");
  const matched = counted.filter((t) => t.status === "matched");
  const unmatched = counted.filter((t) => t.status === "unmatched");
  const excluded = inRange.filter((t) => t.status === "excluded");
  const earlierUnreconciled = all.filter((t) => t.date < rec.statementStart && t.status !== "excluded" && !t.reconciliationId);
  const statementTotalMinor = rec.openingBalanceMinor + counted.reduce((t, x) => t + x.amountMinor, 0);
  const clearedMinor = rec.openingBalanceMinor + matched.reduce((t, x) => t + x.amountMinor, 0);

  // Books: every line on the bank's account through the statement end; outstanding = not cleared by any transaction.
  const lines = (await ctx.db.find(ledgerLines, { accountId: ba.accountId })).filter((l) => l.date <= rec.statementEnd);
  // Book history before the account's first reconciled statement is represented by that statement's
  // opening balance; only lines from then on can be outstanding.
  const firstStart = (await ctx.db.find(reconciliations, { bankAccountId: ba.id })).reduce((m, r) => (r.statementStart < m ? r.statementStart : m), rec.statementStart);
  const openingBookMinor = lines.filter((l) => l.date < firstStart).reduce((t, l) => t + l.debit - l.credit, 0);
  const reversed = new Set<string>();
  for (const e of await ctx.db.find(journalEntries, { status: "posted" })) if (e.reversalOf) { reversed.add(e.id); reversed.add(e.reversalOf); }
  const cleared = new Set((await ctx.db.find(bankMatches, { bankAccountId: ba.id })).map((m) => m.ledgerLineId));
  const outstanding = [];
  for (const l of lines) {
    if (l.date < firstStart || cleared.has(l.id) || reversed.has(l.entryId)) continue;
    const entry = await ctx.db.get(journalEntries, l.entryId);
    outstanding.push({ lineId: l.id, entryId: l.entryId, entryNumber: l.entryNumber, date: l.date, amountMinor: l.debit - l.credit, description: entry?.description ?? "" });
  }
  const bookBalanceMinor = lines.reduce((t, l) => t + l.debit - l.credit, 0);
  const outstandingMinor = outstanding.reduce((t, o) => t + o.amountMinor, 0);
  const statementDifferenceMinor = rec.closingBalanceMinor - statementTotalMinor;
  const differenceMinor = rec.closingBalanceMinor - clearedMinor;
  const discrepancies: string[] = [];
  if (statementDifferenceMinor !== 0) discrepancies.push(`The imported transactions do not add up to the statement: opening + transactions = ${statementTotalMinor}, closing = ${rec.closingBalanceMinor} (off by ${statementDifferenceMinor}). Import the missing rows or check the balances.`);
  if (unmatched.length) discrepancies.push(`${unmatched.length} statement transaction${unmatched.length === 1 ? " is" : "s are"} not in the books yet: match or categorize ${unmatched.length === 1 ? "it" : "them"}.`);
  if (earlierUnreconciled.length) discrepancies.push(`${earlierUnreconciled.length} transaction${earlierUnreconciled.length === 1 ? "" : "s"} dated before this statement ${earlierUnreconciled.length === 1 ? "is" : "are"} in no reconciliation.`);
  if (firstStart === rec.statementStart && openingBookMinor !== rec.openingBalanceMinor) {
    discrepancies.push(`The books show ${openingBookMinor} on ${ba.ledger.name} before ${firstStart}, but the statement opens at ${rec.openingBalanceMinor}. Record opening balances so they agree.`);
  }
  if (bookBalanceMinor - outstandingMinor !== clearedMinor && statementDifferenceMinor === 0 && unmatched.length === 0) {
    discrepancies.push(`Book balance ${bookBalanceMinor} less outstanding items ${outstandingMinor} is ${bookBalanceMinor - outstandingMinor}, but the cleared balance is ${clearedMinor}: an earlier period has an unexplained difference.`);
  }
  return {
    reconciliation: rec,
    bankAccount: { id: ba.id, name: ba.name, ledgerAccountId: ba.accountId, ledgerName: ba.ledger.name },
    matched, unmatched, excluded, outstanding,
    statementTotalMinor, statementDifferenceMinor, clearedMinor, differenceMinor, bookBalanceMinor, outstandingMinor, openingBookMinor,
    earlierUnreconciledCount: earlierUnreconciled.length,
    discrepancies,
    canComplete: rec.status === "in_progress" && statementDifferenceMinor === 0 && unmatched.length === 0 && differenceMinor === 0,
  };
}

export const get = app.query({
  access: "banking.read",
  args: { id: s.string() },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    return workspace(ctx, a.id);
  },
});

export const list = app.query({
  access: "banking.read",
  args: { bankAccountId: s.string() },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    return (await ctx.db.find(reconciliations, { bankAccountId: a.bankAccountId })).sort((x, y) => (x.statementEnd < y.statementEnd ? 1 : -1));
  },
});

export const complete = app.mutation({
  access: "banking.reconcile",
  args: { id: s.string() },
  handler: async (ctx, a) => {
    requirePerson(ctx);
    const w = await workspace(ctx, a.id);
    if (w.reconciliation.status !== "in_progress") fail("FAILED_PRECONDITION", "This reconciliation is already complete.");
    if (!w.canComplete) fail("FAILED_PRECONDITION", `Not reconciled yet: ${w.discrepancies.join(" ") || `difference ${w.differenceMinor}`}`);
    for (const t of [...w.matched, ...w.excluded]) await ctx.db.patch(bankTransactions, t.id, { reconciliationId: w.reconciliation.id });
    const result = {
      bankTransactionIds: w.matched.map((t) => t.id),
      clearedLineIds: w.matched.flatMap((t) => t.matchedLineIds),
      statementTotalMinor: w.statementTotalMinor,
      bookBalanceMinor: w.bookBalanceMinor,
      unclearedBookMinor: w.outstandingMinor,
      differenceMinor: w.differenceMinor,
    };
    await ctx.db.patch(reconciliations, w.reconciliation.id, { status: "completed", result, completedBy: actor(ctx), completedAt: Date.now() });
    await audit.record(ctx, { subject: "reconciliation", id: w.reconciliation.id, type: "reconciliation.completed", data: { ...result, bankTransactionIds: result.bankTransactionIds.length, clearedLineIds: result.clearedLineIds.length, excluded: w.excluded.length, outstanding: w.outstanding.length } });
    return { ok: true };
  },
});

/** Abandon an in-progress session (nothing was stamped). */
export const cancel = app.mutation({
  access: "banking.match",
  args: { id: s.string() },
  handler: async (ctx, a) => {
    const rec = await ctx.db.get(reconciliations, a.id);
    if (!rec) fail("NOT_FOUND", "No such reconciliation.");
    if (rec.status !== "in_progress") fail("FAILED_PRECONDITION", "A completed reconciliation is permanent.");
    await ctx.db.delete(reconciliations, a.id);
    await audit.record(ctx, { subject: "reconciliation", id: a.id, type: "reconciliation.cancelled", data: { statementEnd: rec.statementEnd } });
    return { ok: true };
  },
});
