/**
 * The posting engine: the only code that writes `ledgerLines`.
 *
 * Every workflow (manual journals, invoices, payments, bills, expenses, bank categorization,
 * reversals, approved proposals) posts through `postEntry`, inside the caller's mutation, so the
 * business document, its journal entry, its ledger lines and its audit event commit together or not
 * at all. The rules enforced here are the accounting invariants:
 *
 *   - at least two lines; every amount a non-negative integer; each line exactly one side
 *   - total debits equal total credits, and the total is positive
 *   - every account exists in this organization and is active
 *   - the entry date is after the organization's closed-through date
 *   - a posted entry gets the next number of the organization's gapless journal sequence
 */
import { fail, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { accounts, app, audit, journalEntries, ledgerLines, orgSettings, type SourceType } from "./app.js";

export interface LineInput {
  accountId: string;
  debit: number;
  credit: number;
  memo?: string;
  contactId?: string;
}

export interface PostInput {
  date: string;
  description: string;
  reference?: string;
  sourceType: SourceType;
  sourceId?: string;
  lines: LineInput[];
  reversalOf?: string;
  reason?: string;
  proposalId?: string;
  approvedBy?: string;
  idempotencyKey?: string;
  /** Post an existing draft instead of inserting a new header. */
  draftId?: string;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function requireDate(value: string, what = "date"): string {
  if (!isValidDate(value)) fail("INVALID_ARGUMENT", `${what} must be a real calendar date (YYYY-MM-DD), not "${value}".`);
  return value;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Pure validation of a set of lines. Returns the total (sum of debits). */
export function validateLines(lines: readonly LineInput[]): number {
  if (lines.length < 2) fail("INVALID_ARGUMENT", "A journal entry needs at least two lines.");
  let debits = 0;
  let credits = 0;
  lines.forEach((l, i) => {
    for (const [side, v] of [["debit", l.debit], ["credit", l.credit]] as const) {
      if (!Number.isSafeInteger(v) || v < 0) fail("INVALID_ARGUMENT", `Line ${i + 1}: ${side} must be a non-negative whole number of minor units.`);
    }
    if ((l.debit > 0) === (l.credit > 0)) fail("INVALID_ARGUMENT", `Line ${i + 1}: enter either a debit or a credit, not ${l.debit > 0 ? "both" : "neither"}.`);
    debits += l.debit;
    credits += l.credit;
  });
  if (debits !== credits) fail("INVALID_ARGUMENT", `The entry does not balance: debits ${debits} ≠ credits ${credits}.`);
  if (!Number.isSafeInteger(debits)) fail("INVALID_ARGUMENT", "The entry total is too large.");
  return debits;
}

/** The organization's settings. Fails when the organization has not been set up. */
export async function requireSettings(ctx: QueryCtx | MutationCtx) {
  app.requireTenant(ctx);
  const [settings] = await ctx.db.find(orgSettings, {});
  if (!settings) fail("FAILED_PRECONDITION", "Set up the organization first (Settings → Organization).");
  return settings;
}

export function requireOpenPeriod(closedThrough: string, date: string) {
  if (closedThrough && date <= closedThrough) {
    fail("FAILED_PRECONDITION", `The books are closed through ${closedThrough}. Date the entry after it, or ask an accountant to reopen the period.`);
  }
}

export function actor(ctx: QueryCtx | MutationCtx): string {
  return ctx.auth.requirePrincipal().id;
}

/** Load every referenced account once and check they exist (in this organization) and are active. */
export async function requireActiveAccounts(ctx: QueryCtx | MutationCtx, ids: readonly string[]) {
  const found = new Map<string, Awaited<ReturnType<typeof loadAccount>>>();
  for (const id of new Set(ids)) {
    const account = await loadAccount(ctx, id);
    if (!account) fail("INVALID_ARGUMENT", `Unknown account ${id}.`);
    if (!account.active) fail("FAILED_PRECONDITION", `Account ${account.number} ${account.name} is inactive.`);
    found.set(id, account);
  }
  return found as Map<string, NonNullable<Awaited<ReturnType<typeof loadAccount>>>>;
}

function loadAccount(ctx: QueryCtx | MutationCtx, id: string) {
  return ctx.db.get(accounts, id);
}

/** Sources allowed to post to the receivable / payable control accounts: the documents those subledgers track. */
const CONTROL_SOURCES: Record<string, ReadonlySet<string>> = {
  receivable: new Set(["invoice", "credit_note", "payment_received"]),
  payable: new Set(["bill", "payment_made"]),
};

/**
 * Accounts Receivable and Accounts Payable are control accounts: their balance must equal the open
 * invoices and bills. Only those documents' workflows post to them; a manual journal, a bank
 * categorization or an opening balance cannot.
 */
export function requireControlAccountsByWorkflow(sourceType: string, used: ReadonlyArray<{ subtype: string; system: boolean; name: string }>) {
  for (const acc of used) {
    const allowed = acc.system ? CONTROL_SOURCES[acc.subtype] : undefined;
    if (allowed && !allowed.has(sourceType)) {
      fail("FAILED_PRECONDITION", `${acc.name} is a control account kept by ${acc.subtype === "receivable" ? "invoices, credit notes and customer payments" : "bills and vendor payments"}. Record the document instead of a journal line.`);
    }
  }
}

/** The system account of a subtype (receivable, payable, tax_payable, opening_balance, retained_earnings). */
export async function systemAccount(ctx: QueryCtx | MutationCtx, subtype: "receivable" | "payable" | "opening_balance" | "retained_earnings") {
  const [account] = await ctx.db.find(accounts, { subtype, system: true });
  if (!account) fail("FAILED_PRECONDITION", `This organization has no ${subtype.replace("_", " ")} account.`);
  return account;
}

/**
 * Post a balanced entry. Inserts (or promotes a draft to) a posted header and its ledger lines,
 * and records an audit event, all in the caller's transaction. Returns the posted header.
 */
export async function postEntry(ctx: MutationCtx, input: PostInput) {
  const tenant = app.requireTenant(ctx);
  const who = actor(ctx);
  requireDate(input.date);
  const description = input.description.trim();
  if (!description) fail("INVALID_ARGUMENT", "A journal entry needs a description.");
  const total = validateLines(input.lines);
  if (total <= 0) fail("INVALID_ARGUMENT", "A journal entry must move a positive amount.");
  const settings = await requireSettings(ctx);
  requireOpenPeriod(settings.closedThrough, input.date);
  const used = await requireActiveAccounts(ctx, input.lines.map((l) => l.accountId));
  requireControlAccountsByWorkflow(input.sourceType, [...used.values()]);

  const number = await ctx.db.sequence(`journal:${tenant.id}`);
  const now = Date.now();
  const header = {
    number,
    status: "posted" as const,
    date: input.date,
    description,
    sourceType: input.sourceType,
    totalMinor: total,
    createdBy: who,
    createdAt: now,
    postedBy: who,
    postedAt: now,
    ...(input.reference ? { reference: input.reference } : {}),
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    ...(input.reversalOf ? { reversalOf: input.reversalOf } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.proposalId ? { proposalId: input.proposalId } : {}),
    ...(input.approvedBy ? { approvedBy: input.approvedBy } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  };
  let entryId: string;
  if (input.draftId) {
    const draft = await ctx.db.get(journalEntries, input.draftId);
    if (!draft) fail("NOT_FOUND", "No such journal entry.");
    if (draft.status !== "draft") fail("FAILED_PRECONDITION", `Journal entry ${draft.number} is already posted.`);
    await ctx.db.replace(journalEntries, draft.id, { ...header, createdBy: draft.createdBy, createdAt: draft.createdAt } as never);
    entryId = draft.id;
  } else {
    entryId = await ctx.db.insert(journalEntries, header);
  }
  let lineNo = 0;
  for (const l of input.lines) {
    await ctx.db.insert(ledgerLines, {
      entryId,
      entryNumber: number,
      lineNo: ++lineNo,
      date: input.date,
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      sourceType: input.sourceType,
      ...(l.memo ? { memo: l.memo } : {}),
      ...(l.contactId ? { contactId: l.contactId } : {}),
    });
  }
  await audit.record(ctx, {
    subject: "journal",
    id: entryId,
    type: input.reversalOf ? "journal.reversed" : "journal.posted",
    data: {
      number, date: input.date, totalMinor: total, sourceType: input.sourceType,
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      ...(input.reversalOf ? { reversalOf: input.reversalOf } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.proposalId ? { proposalId: input.proposalId, approvedBy: input.approvedBy } : {}),
    },
  });
  return { id: entryId, ...header };
}

/** The posted lines of one entry, in order. */
export async function entryLines(ctx: QueryCtx | MutationCtx, entryId: string) {
  return ctx.db.find(ledgerLines, { entryId }, { orderBy: [{ field: "lineNo", direction: "asc" }] });
}

/**
 * Reverse a posted entry with a new entry that swaps every debit and credit. The original is never
 * changed; the unique (reversalOf) constraint makes a second reversal impossible, even concurrently.
 */
export async function reverseEntry(ctx: MutationCtx, entryId: string, input: { date: string; reason: string; sourceType?: SourceType; sourceId?: string }) {
  const original = await ctx.db.get(journalEntries, entryId);
  if (!original) fail("NOT_FOUND", "No such journal entry.");
  if (original.status !== "posted") fail("FAILED_PRECONDITION", "Only a posted entry can be reversed; delete a draft instead.");
  if (original.reversalOf) fail("FAILED_PRECONDITION", `Entry ${original.number} is itself a reversal.`);
  const [already] = await ctx.db.find(journalEntries, { reversalOf: entryId });
  if (already) fail("FAILED_PRECONDITION", `Entry ${original.number} was already reversed by entry ${already.number}.`);
  if (input.date < original.date) fail("INVALID_ARGUMENT", `A reversal cannot be dated before the entry it reverses (${original.date}).`);
  const reason = input.reason.trim();
  if (!reason) fail("INVALID_ARGUMENT", "Say why the entry is being reversed.");
  const lines = await entryLines(ctx, entryId);
  return postEntry(ctx, {
    date: input.date,
    description: `Reversal of #${original.number}: ${original.description}`.slice(0, 300),
    sourceType: input.sourceType ?? "reversal",
    sourceId: input.sourceId ?? original.sourceId,
    reversalOf: entryId,
    reason,
    lines: lines.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit, ...(l.memo ? { memo: l.memo } : {}), ...(l.contactId ? { contactId: l.contactId } : {}) })),
  });
}

/** Debit-normal account types: their balance is debits − credits. */
export function isDebitNormal(type: string): boolean {
  return type === "asset" || type === "expense";
}

/** A signed balance in the account's normal direction. */
export function normalBalance(type: string, debit: number, credit: number): number {
  return isDebitNormal(type) ? debit - credit : credit - debit;
}

/**
 * Patch a record and remove fields. `patch` cannot remove a field (an `undefined` value is not
 * stored), so the record is replaced without them. Its version is still checked at commit.
 */
export async function patchRemoving<C extends Parameters<MutationCtx["db"]["get"]>[0]>(ctx: MutationCtx, collection: C, id: string, patch: Record<string, unknown>, remove: string[]) {
  const current = (await ctx.db.get(collection, id)) as Record<string, unknown> | null;
  if (!current) fail("NOT_FOUND", "No such record.");
  const { id: _id, __version: _v, ...rest } = current;
  const next: Record<string, unknown> = { ...rest, ...patch };
  for (const f of remove) delete next[f];
  return ctx.db.replace(collection, id, next as never);
}
