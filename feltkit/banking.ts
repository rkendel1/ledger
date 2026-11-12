/**
 * Banking: bank accounts, CSV statement import, categorizing (with splits), matching to existing
 * ledger lines, and excluding — never discarding — transactions.
 *
 * A bank transaction is "matched" when ledger lines on the bank's ledger account explain it: either
 * lines that already exist (a recorded payment, expense or transfer), or the bank-side line of an
 * entry created by categorizing it. `bankMatches` holds each cleared line once (unique), so a line can
 * never clear two transactions.
 */
import { fail, s, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { accounts, app, audit, bankAccounts, proposals, bankMatches, bankTransactions, expenses, journalEntries, ledgerLines, reconciliations, statementImports } from "./app.js";
import { actor, addDays, daysBetween, entryLines, normalBalance, patchRemoving, postEntry, requireSettings, reverseEntry, requirePerson } from "./_ledger.js";
import { normalizePayee, parseStatement, sha256Hex } from "./_csv.js";
import { requireBankAccount } from "./_bank.js";

type Ctx = QueryCtx | MutationCtx;
const BANK_SUBTYPES = new Set(["bank", "cash", "credit_card"]);


export const createAccount = app.mutation({
  access: "accounts.write",
  args: {
    name: s.string({ minLength: 1, maxLength: 120 }),
    /** An existing cash, bank or credit-card ledger account; or omit and give `newAccountNumber` to create one. */
    accountId: s.optional(s.string()),
    newAccountNumber: s.optional(s.string({ pattern: "^[0-9]{3,8}$" })),
    kind: s.optional(s.enum(["bank", "credit_card"] as const)),
    institution: s.optional(s.string({ maxLength: 120 })),
    last4: s.optional(s.string({ pattern: "^[0-9]{4}$" })),
  },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    let accountId = a.accountId;
    if (accountId) {
      const acc = await ctx.db.get(accounts, accountId);
      if (!acc || !BANK_SUBTYPES.has(acc.subtype)) fail("INVALID_ARGUMENT", "Link a cash, bank or credit-card ledger account.");
      const [taken] = await ctx.db.find(bankAccounts, { accountId });
      if (taken) fail("CONFLICT", `${acc.name} already feeds ${taken.name}.`);
    } else {
      if (!a.newAccountNumber) fail("INVALID_ARGUMENT", "Give an existing ledger account or a number for a new one.");
      const [dup] = await ctx.db.find(accounts, { number: a.newAccountNumber });
      if (dup) fail("CONFLICT", `Account number ${a.newAccountNumber} is taken by ${dup.name}.`);
      const kind = a.kind ?? "bank";
      accountId = await ctx.db.insert(accounts, { number: a.newAccountNumber, name: a.name, type: kind === "bank" ? "asset" : "liability", subtype: kind, active: true, system: false, createdAt: Date.now() });
    }
    const id = await ctx.db.insert(bankAccounts, { name: a.name.trim(), accountId, createdAt: Date.now(), ...(a.institution ? { institution: a.institution } : {}), ...(a.last4 ? { last4: a.last4 } : {}) });
    await audit.record(ctx, { subject: "bank", id, type: "bankaccount.created", data: { name: a.name, accountId } });
    return id;
  },
});

export const listAccounts = app.query({
  access: "banking.read",
  handler: async (ctx) => {
    await requireSettings(ctx);
    const out = [];
    for (const ba of await ctx.db.find(bankAccounts, {})) {
      const ledger = await ctx.db.get(accounts, ba.accountId);
      const lines = await ctx.db.find(ledgerLines, { accountId: ba.accountId });
      const balance = lines.reduce((t, l) => t + normalBalance(ledger?.type ?? "asset", l.debit, l.credit), 0);
      const unmatched = await ctx.db.count(bankTransactions, { bankAccountId: ba.id, status: "unmatched" });
      const recs = (await ctx.db.find(reconciliations, { bankAccountId: ba.id })).sort((x, y) => (x.statementEnd < y.statementEnd ? 1 : -1));
      const last = recs.find((r) => r.status === "completed");
      const open = recs.find((r) => r.status === "in_progress");
      out.push({
        ...ba, ledgerName: ledger?.name ?? "?", ledgerNumber: ledger?.number ?? "?", ledgerType: ledger?.type ?? "asset",
        bookBalanceMinor: balance, unmatchedCount: unmatched,
        lastReconciled: last ? { id: last.id, statementEnd: last.statementEnd, closingBalanceMinor: last.closingBalanceMinor } : null,
        openReconciliationId: open?.id ?? null,
      });
    }
    return out;
  },
});

/**
 * Import a CSV statement. The file itself is kept in the Files service (provenance), the import
 * records every row's fate: imported, duplicate (with the transaction it duplicates) or rejected
 * (with the reason). Re-importing the same file returns the earlier import.
 */
export const importStatement = app.mutation({
  access: "banking.import",
  args: {
    bankAccountId: s.string(),
    fileName: s.string({ minLength: 1, maxLength: 200 }),
    csv: s.string({ minLength: 1, maxLength: 5_000_000 }),
    dateFormat: s.optional(s.enum(["auto", "ymd", "mdy", "dmy"] as const)),
    /** Credit-card statements usually show charges as positive amounts: flip them so money out is negative. */
    invertSigns: s.optional(s.boolean()),
  },
  handler: async (ctx, a) => {
    const tenant = app.requireTenant(ctx);
    const ba = await requireBankAccount(ctx, a.bankAccountId);
    const sha256 = await sha256Hex(a.csv);
    const [prior] = await ctx.db.find(statementImports, { bankAccountId: ba.id, sha256 });
    if (prior) return { importId: prior.id, replayed: true, imported: prior.importedCount, duplicates: prior.duplicates.length, rejected: prior.rejected.length };
    let parsed;
    try {
      parsed = parseStatement(a.csv, a.dateFormat ?? "auto");
    } catch (e) {
      fail("INVALID_ARGUMENT", (e as Error).message);
    }
    if (parsed.rows.length === 0 && parsed.rejected.length === 0) fail("INVALID_ARGUMENT", "The statement has no rows.");
    const file = await ctx.services.files.upload({ name: a.fileName, contentType: "text/csv", content: a.csv, metadata: { ledgerTenant: tenant.id, kind: "statement", bankAccountId: ba.id } });
    const importId = await ctx.db.insert(statementImports, {
      bankAccountId: ba.id, fileId: file.id, fileName: a.fileName, sha256, rowCount: parsed.rows.length + parsed.rejected.length,
      importedCount: 0, duplicates: [], rejected: parsed.rejected, periodStart: "", periodEnd: "", importedBy: actor(ctx), at: Date.now(),
    });
    const occurrences = new Map<string, number>();
    const duplicates: Array<{ row: number; date: string; amountMinor: number; description: string; existingId: string }> = [];
    let imported = 0;
    let start = "";
    let end = "";
    for (const r of parsed.rows) {
      const amountMinor = a.invertSigns ? -r.amountMinor : r.amountMinor;
      const payee = normalizePayee(r.description);
      const base = `${r.date}|${amountMinor}|${payee}`;
      const n = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, n);
      const fingerprint = `${base}|${n}`;
      if (!start || r.date < start) start = r.date;
      if (!end || r.date > end) end = r.date;
      const [existing] = await ctx.db.find(bankTransactions, { bankAccountId: ba.id, fingerprint });
      if (existing) {
        duplicates.push({ row: r.row, date: r.date, amountMinor, description: r.description, existingId: existing.id });
        continue;
      }
      await ctx.db.insert(bankTransactions, { bankAccountId: ba.id, importId, row: r.row, date: r.date, description: r.description, payee, amountMinor, fingerprint, status: "unmatched", matchedLineIds: [] });
      imported++;
    }
    await ctx.db.patch(statementImports, importId, { importedCount: imported, duplicates, periodStart: start, periodEnd: end });
    await audit.record(ctx, { subject: "bank", id: importId, type: "statement.imported", data: { bankAccountId: ba.id, fileName: a.fileName, sha256, fileId: file.id, imported, duplicates: duplicates.length, rejected: parsed.rejected.length, periodStart: start, periodEnd: end } });
    return { importId, replayed: false, imported, duplicates: duplicates.length, rejected: parsed.rejected.length };
  },
});

export const imports = app.query({
  access: "banking.read",
  args: { bankAccountId: s.string() },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    return (await ctx.db.find(statementImports, { bankAccountId: a.bankAccountId })).sort((x, y) => y.at - x.at);
  },
});

export const transactions = app.query({
  access: "banking.read",
  args: { bankAccountId: s.string(), status: s.optional(s.enum(["unmatched", "matched", "excluded"] as const)) },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const rows = await ctx.db.find(bankTransactions, a.status ? { bankAccountId: a.bankAccountId, status: a.status } : { bankAccountId: a.bankAccountId });
    return rows.sort((x, y) => (x.date === y.date ? y.row - x.row : x.date < y.date ? 1 : -1));
  },
});

async function requireTxn(ctx: Ctx, id: string) {
  const txn = await ctx.db.get(bankTransactions, id);
  if (!txn) fail("NOT_FOUND", "No such bank transaction.");
  return txn;
}

/** Ledger lines on the bank's account whose entry was reversed, or which reverse another: they net to zero and never clear a transaction. */
async function reversedEntryIds(ctx: Ctx) {
  const ids = new Set<string>();
  for (const e of await ctx.db.find(journalEntries, { status: "posted" })) {
    if (e.reversalOf) {
      ids.add(e.id);
      ids.add(e.reversalOf);
    }
  }
  return ids;
}

/** Unmatched ledger lines on the bank's account that could explain a transaction: same signed amount, nearest dates first. */
export async function candidateLines(ctx: Ctx, txn: { bankAccountId: string; amountMinor: number; date: string }, windowDays = 10) {
  const ba = await requireBankAccount(ctx, txn.bankAccountId);
  const reversed = await reversedEntryIds(ctx);
  const lines = await ctx.db.find(ledgerLines, { accountId: ba.accountId });
  const out = [];
  for (const l of lines) {
    if (reversed.has(l.entryId)) continue;
    const signed = l.debit - l.credit; // money into an asset account is a debit
    // Statement sign: money in is positive. For a bank (asset) that is a debit; for a credit card
    // (liability) a payment to the card is a debit too, and a charge a credit: the same rule.
    const effect = signed;
    if (effect !== txn.amountMinor) continue;
    if (Math.abs(daysBetween(txn.date, l.date)) > windowDays) continue;
    const [m] = await ctx.db.find(bankMatches, { ledgerLineId: l.id });
    if (m) continue;
    const entry = await ctx.db.get(journalEntries, l.entryId);
    out.push({ lineId: l.id, entryId: l.entryId, entryNumber: l.entryNumber, date: l.date, amountMinor: effect, description: entry?.description ?? "", sourceType: l.sourceType, dayGap: Math.abs(daysBetween(txn.date, l.date)) });
  }
  return out.sort((x, y) => x.dayGap - y.dayGap);
}

export const candidates = app.query({
  access: "banking.read",
  args: { bankTransactionId: s.string() },
  handler: async (ctx, a) => candidateLines(ctx, await requireTxn(ctx, a.bankTransactionId)),
});

/** Record that `lineIds` explain the transaction. Used by match, categorize and approved proposals. */
export async function applyMatch(ctx: MutationCtx, txnId: string, lineIds: string[], executingProposalId?: string) {
  const txn = await requireTxn(ctx, txnId);
  if (txn.status !== "unmatched") fail("FAILED_PRECONDITION", `This transaction is ${txn.status}.`);
  if (lineIds.length === 0 || new Set(lineIds).size !== lineIds.length) fail("INVALID_ARGUMENT", "Name each ledger line once.");
  const ba = await requireBankAccount(ctx, txn.bankAccountId);
  const reversed = await reversedEntryIds(ctx);
  let sum = 0;
  for (const id of lineIds) {
    const l = await ctx.db.get(ledgerLines, id);
    if (!l) fail("NOT_FOUND", "No such ledger line.");
    if (l.accountId !== ba.accountId) fail("INVALID_ARGUMENT", `A matched line must be on ${ba.ledger.name}.`);
    if (reversed.has(l.entryId)) fail("FAILED_PRECONDITION", `Entry #${l.entryNumber} was reversed; it cannot clear a bank transaction.`);
    const [m] = await ctx.db.find(bankMatches, { ledgerLineId: id });
    if (m) fail("CONFLICT", `Entry #${l.entryNumber}'s line already clears another bank transaction.`);
    sum += l.debit - l.credit;
    await ctx.db.insert(bankMatches, { bankTransactionId: txn.id, ledgerLineId: id, bankAccountId: ba.id });
    // An expense paid from this account now points at the bank transaction that evidences it.
    const entry = await ctx.db.get(journalEntries, l.entryId);
    if (entry?.sourceType === "expense" && entry.sourceId) {
      const exp = await ctx.db.get(expenses, entry.sourceId);
      if (exp && !exp.bankTransactionId) await ctx.db.patch(expenses, exp.id, { bankTransactionId: txn.id });
    }
  }
  if (sum !== txn.amountMinor) fail("INVALID_ARGUMENT", `The lines total ${sum}; the bank transaction is ${txn.amountMinor}.`);
  await ctx.db.patch(bankTransactions, txn.id, { status: "matched", matchedLineIds: lineIds, matchedBy: actor(ctx) });
  // Any other open proposal for this transaction is now moot: record that, rather than leave it pending.
  for (const p of await ctx.db.find(proposals, { subjectKey: `bank:${txn.id}` })) {
    if (p.status === "pending" && p.id !== executingProposalId) {
      await ctx.db.patch(proposals, p.id, { status: "superseded", decidedBy: actor(ctx), decidedAt: Date.now(), decisionReason: "The transaction was explained directly." });
      await audit.record(ctx, { subject: "proposal", id: p.id, type: "proposal.superseded", data: { bankTransactionId: txn.id } });
    }
  }
  return txn;
}

export const match = app.mutation({
  access: "banking.match",
  args: { bankTransactionId: s.string(), ledgerLineIds: s.array(s.string(), { minItems: 1, maxItems: 50 }) },
  handler: async (ctx, a) => {
    requirePerson(ctx);
    const txn = await applyMatch(ctx, a.bankTransactionId, a.ledgerLineIds);
    await audit.record(ctx, { subject: "bank", id: txn.id, type: "banktxn.matched", data: { ledgerLineIds: a.ledgerLineIds, amountMinor: txn.amountMinor } });
    return { ok: true };
  },
});

export interface Split {
  accountId: string;
  amountMinor: number;
  memo?: string;
  contactId?: string;
}

/** Create the entry that explains a bank transaction, split across accounts, and match it. */
export async function applyCategorize(ctx: MutationCtx, txnId: string, splits: Split[], extra: { proposalId?: string; approvedBy?: string } = {}) {
  const txn = await requireTxn(ctx, txnId);
  if (txn.status !== "unmatched") fail("FAILED_PRECONDITION", `This transaction is ${txn.status}.`);
  const ba = await requireBankAccount(ctx, txn.bankAccountId);
  const total = splits.reduce((t, x) => t + x.amountMinor, 0);
  if (splits.some((x) => !Number.isSafeInteger(x.amountMinor) || x.amountMinor <= 0)) fail("INVALID_ARGUMENT", "Each split is a positive amount.");
  if (total !== Math.abs(txn.amountMinor)) fail("INVALID_ARGUMENT", `The splits total ${total}; the transaction is ${Math.abs(txn.amountMinor)}.`);
  if (splits.some((x) => x.accountId === ba.accountId)) fail("INVALID_ARGUMENT", "A split cannot go to the bank account itself.");
  const inflow = txn.amountMinor > 0;
  const memo = txn.description;
  const entry = await postEntry(ctx, {
    date: txn.date, description: txn.description.slice(0, 300), sourceType: "bank", sourceId: txn.id,
    ...(extra.proposalId ? { proposalId: extra.proposalId, approvedBy: extra.approvedBy! } : {}),
    lines: [
      { accountId: ba.accountId, debit: inflow ? total : 0, credit: inflow ? 0 : total, memo },
      ...splits.map((x) => ({ accountId: x.accountId, debit: inflow ? 0 : x.amountMinor, credit: inflow ? x.amountMinor : 0, memo: x.memo ?? memo, ...(x.contactId ? { contactId: x.contactId } : {}) })),
    ],
  });
  const bankLine = (await entryLines(ctx, entry.id)).find((l) => l.accountId === ba.accountId)!;
  await applyMatch(ctx, txn.id, [bankLine.id], extra.proposalId);
  await ctx.db.patch(bankTransactions, txn.id, { journalEntryId: entry.id });
  await audit.record(ctx, { subject: "bank", id: txn.id, type: "banktxn.categorized", data: { journalEntryId: entry.id, splits: splits.map((x) => ({ accountId: x.accountId, amountMinor: x.amountMinor })), ...(extra.proposalId ? { proposalId: extra.proposalId } : {}) } });
  return { journalEntryId: entry.id, number: entry.number };
}

const splitArg = s.object({ accountId: s.string(), amountMinor: s.integer({ minimum: 1 }), memo: s.optional(s.string({ maxLength: 300 })), contactId: s.optional(s.string()) });

export const categorize = app.mutation({
  access: "banking.categorize",
  args: { bankTransactionId: s.string(), splits: s.array(splitArg, { minItems: 1, maxItems: 20 }) },
  returns: s.object({ journalEntryId: s.string(), number: s.integer() }),
  retry: { sequenceConflicts: 3 },
  capability: { name: "banking.categorize", description: "Categorize (and optionally split) a bank transaction into a posted entry. People only; agents may propose." },
  handler: (ctx, a) => {
    requirePerson(ctx);
    return applyCategorize(ctx, a.bankTransactionId, a.splits.map((x) => ({ accountId: x.accountId, amountMinor: x.amountMinor, ...(x.memo ? { memo: x.memo } : {}), ...(x.contactId ? { contactId: x.contactId } : {}) })));
  },
});

/**
 * Undo a match. A categorized transaction's entry is reversed (dated like the original), so the
 * ledger keeps both. Refused once the transaction is part of a completed reconciliation.
 */
export const unmatch = app.mutation({
  access: "banking.match",
  args: { bankTransactionId: s.string(), reason: s.string({ minLength: 3, maxLength: 500 }) },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, a) => {
    requirePerson(ctx);
    const txn = await requireTxn(ctx, a.bankTransactionId);
    if (txn.status !== "matched") fail("FAILED_PRECONDITION", "This transaction is not matched.");
    if (txn.reconciliationId) {
      const rec = await ctx.db.get(reconciliations, txn.reconciliationId);
      if (rec?.status === "completed") fail("FAILED_PRECONDITION", `This transaction is part of the reconciliation through ${rec.statementEnd}. It cannot be unmatched.`);
    }
    for (const m of await ctx.db.find(bankMatches, { bankTransactionId: txn.id })) await ctx.db.delete(bankMatches, m.id);
    let reversalId: string | undefined;
    if (txn.journalEntryId) {
      const settings = await requireSettings(ctx);
      const date = settings.closedThrough && txn.date <= settings.closedThrough ? addDays(settings.closedThrough, 1) : txn.date;
      reversalId = (await reverseEntry(ctx, txn.journalEntryId, { date, reason: `Uncategorized bank transaction: ${a.reason}`, sourceType: "bank", sourceId: txn.id })).id;
    }
    await patchRemoving(ctx, bankTransactions, txn.id, { status: "unmatched", matchedLineIds: [] }, ["journalEntryId", "matchedBy"]);
    await audit.record(ctx, { subject: "bank", id: txn.id, type: "banktxn.unmatched", data: { reason: a.reason, ...(reversalId ? { reversalEntryId: reversalId } : {}) } });
    return { ok: true, reversalEntryId: reversalId ?? null };
  },
});

/** Set a transaction aside (e.g. a duplicate from another feed) with a reason. It is kept and listed, never deleted. */
export const exclude = app.mutation({
  access: "banking.match",
  args: { bankTransactionId: s.string(), reason: s.string({ minLength: 3, maxLength: 500 }) },
  handler: async (ctx, a) => {
    const txn = await requireTxn(ctx, a.bankTransactionId);
    if (txn.status !== "unmatched") fail("FAILED_PRECONDITION", "Only an unmatched transaction can be excluded.");
    await ctx.db.patch(bankTransactions, txn.id, { status: "excluded", excludedReason: a.reason });
    await audit.record(ctx, { subject: "bank", id: txn.id, type: "banktxn.excluded", data: { reason: a.reason, amountMinor: txn.amountMinor, date: txn.date } });
    return { ok: true };
  },
});

export const include = app.mutation({
  access: "banking.match",
  args: { bankTransactionId: s.string() },
  handler: async (ctx, a) => {
    const txn = await requireTxn(ctx, a.bankTransactionId);
    if (txn.status !== "excluded") fail("FAILED_PRECONDITION", "This transaction is not excluded.");
    if (txn.reconciliationId) fail("FAILED_PRECONDITION", "This transaction is part of a completed reconciliation.");
    await patchRemoving(ctx, bankTransactions, txn.id, { status: "unmatched" }, ["excludedReason"]);
    await audit.record(ctx, { subject: "bank", id: txn.id, type: "banktxn.included", data: {} });
    return { ok: true };
  },
});
