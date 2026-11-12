/**
 * Expenses and receipts.
 *
 *   draft    — recorded by a bookkeeper, with receipts attached; editable
 *   approved — an approver (expenses.approve) posts Dr expense · Cr the account it was paid from
 *   rejected — kept, with the reviewer's note; no accounting effect
 *
 * Receipts are AppPort Services Files. The Files service is application-wide, not per organization,
 * so Ledger binds a file to an organization itself: an upload carries the organization and subject in
 * metadata the client cannot change, and `attach` checks both, and the uploader, before binding. A
 * receipt is only ever read through its organization-scoped `receipts` record.
 */
import { fail, s, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { accounts, app, audit, bills, contacts, expenses, receipts } from "./app.js";
import { actor, postEntry, requireDate, requireSettings, requirePerson } from "./_ledger.js";
import { fromBase64, toBase64 } from "./_base64.js";

type Ctx = QueryCtx | MutationCtx;
const PAID_FROM = new Set(["cash", "bank", "credit_card"]);
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

async function checkAccounts(ctx: Ctx, expenseAccountId: string, paidFromAccountId: string) {
  const exp = await ctx.db.get(accounts, expenseAccountId);
  if (!exp || !(exp.type === "expense" || exp.subtype === "other_current_asset" || exp.subtype === "fixed_asset")) fail("INVALID_ARGUMENT", "Categorize the expense to an expense (or prepaid / fixed asset) account.");
  if (!exp.active) fail("FAILED_PRECONDITION", `${exp.name} is inactive.`);
  const from = await ctx.db.get(accounts, paidFromAccountId);
  if (!from || !PAID_FROM.has(from.subtype)) fail("INVALID_ARGUMENT", "An expense is paid from a cash, bank or credit-card account.");
}

const fields = {
  date: s.string(),
  vendorId: s.optional(s.string()),
  description: s.string({ minLength: 1, maxLength: 300 }),
  amountMinor: s.integer({ minimum: 1 }),
  currency: s.optional(s.string({ pattern: "^[A-Z]{3}$" })),
  expenseAccountId: s.string(),
  paidFromAccountId: s.string(),
};

async function validate(ctx: Ctx, a: { date: string; vendorId?: string; currency?: string; expenseAccountId: string; paidFromAccountId: string }) {
  const settings = await requireSettings(ctx);
  requireDate(a.date);
  const currency = a.currency ?? settings.baseCurrency;
  if (currency !== settings.baseCurrency) fail("INVALID_ARGUMENT", `Ledger records in ${settings.baseCurrency} only; convert the amount first (multi-currency is not supported yet).`);
  if (a.vendorId) {
    const v = await ctx.db.get(contacts, a.vendorId);
    if (!v || v.kind !== "vendor") fail("INVALID_ARGUMENT", "Unknown vendor.");
  }
  await checkAccounts(ctx, a.expenseAccountId, a.paidFromAccountId);
  return currency;
}

export const create = app.mutation({
  access: "expenses.write",
  args: fields,
  handler: async (ctx, a) => {
    const currency = await validate(ctx, a);
    const id = await ctx.db.insert(expenses, {
      date: a.date, description: a.description.trim(), amountMinor: a.amountMinor, currency, expenseAccountId: a.expenseAccountId, paidFromAccountId: a.paidFromAccountId,
      status: "draft", createdBy: actor(ctx), createdAt: Date.now(), ...(a.vendorId ? { vendorId: a.vendorId } : {}),
    });
    await audit.record(ctx, { subject: "expense", id, type: "expense.recorded", data: { amountMinor: a.amountMinor, date: a.date, expenseAccountId: a.expenseAccountId } });
    return id;
  },
});

export const update = app.mutation({
  access: "expenses.write",
  args: { id: s.string(), ...fields },
  handler: async (ctx, a) => {
    const e = await ctx.db.get(expenses, a.id);
    if (!e) fail("NOT_FOUND", "No such expense.");
    if (e.status !== "draft") fail("FAILED_PRECONDITION", `This expense is ${e.status} and can no longer be changed.`);
    const currency = await validate(ctx, a);
    const before = { date: e.date, amountMinor: e.amountMinor, expenseAccountId: e.expenseAccountId, paidFromAccountId: e.paidFromAccountId, description: e.description };
    await ctx.db.patch(expenses, a.id, { date: a.date, description: a.description.trim(), amountMinor: a.amountMinor, currency, expenseAccountId: a.expenseAccountId, paidFromAccountId: a.paidFromAccountId, ...(a.vendorId ? { vendorId: a.vendorId } : {}) });
    await audit.record(ctx, { subject: "expense", id: a.id, type: "expense.updated", data: { before, after: { date: a.date, amountMinor: a.amountMinor, expenseAccountId: a.expenseAccountId, paidFromAccountId: a.paidFromAccountId, description: a.description } } });
    return { ok: true };
  },
});

export const approve = app.mutation({
  access: "expenses.approve",
  args: { id: s.string(), note: s.optional(s.string({ maxLength: 500 })) },
  returns: s.object({ journalEntryId: s.string() }),
  retry: { sequenceConflicts: 3 },
  capability: { name: "expenses.approve", description: "Approve an expense and post it. People only; agents may propose." },
  handler: async (ctx, a) => {
    requirePerson(ctx);
    const e = await ctx.db.get(expenses, a.id);
    if (!e) fail("NOT_FOUND", "No such expense.");
    if (e.status !== "draft") fail("FAILED_PRECONDITION", `This expense is already ${e.status}.`);
    await checkAccounts(ctx, e.expenseAccountId, e.paidFromAccountId);
    const memo = e.description;
    const entry = await postEntry(ctx, {
      date: e.date, description: `Expense: ${e.description}`.slice(0, 300), sourceType: "expense", sourceId: e.id,
      lines: [
        { accountId: e.expenseAccountId, debit: e.amountMinor, credit: 0, memo, ...(e.vendorId ? { contactId: e.vendorId } : {}) },
        { accountId: e.paidFromAccountId, debit: 0, credit: e.amountMinor, memo, ...(e.vendorId ? { contactId: e.vendorId } : {}) },
      ],
    });
    const who = actor(ctx);
    await ctx.db.patch(expenses, a.id, { status: "approved", journalEntryId: entry.id, reviewedBy: who, ...(a.note ? { reviewNote: a.note } : {}) });
    const receiptCount = await ctx.db.count(receipts, { subjectId: e.id });
    await audit.record(ctx, { subject: "expense", id: a.id, type: "expense.approved", data: { journalEntryId: entry.id, amountMinor: e.amountMinor, receipts: receiptCount, ...(a.note ? { note: a.note } : {}) } });
    return { journalEntryId: entry.id };
  },
});

export const reject = app.mutation({
  access: "expenses.approve",
  args: { id: s.string(), note: s.string({ minLength: 3, maxLength: 500 }) },
  handler: async (ctx, a) => {
    requirePerson(ctx);
    const e = await ctx.db.get(expenses, a.id);
    if (!e) fail("NOT_FOUND", "No such expense.");
    if (e.status !== "draft") fail("FAILED_PRECONDITION", `This expense is already ${e.status}.`);
    await ctx.db.patch(expenses, a.id, { status: "rejected", reviewedBy: actor(ctx), reviewNote: a.note });
    await audit.record(ctx, { subject: "expense", id: a.id, type: "expense.rejected", data: { note: a.note } });
    return { ok: true };
  },
});

export const list = app.query({
  access: "expenses.read",
  args: { status: s.optional(s.enum(["draft", "approved", "rejected"] as const)) },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const rows = await ctx.db.find(expenses, a.status ? { status: a.status } : {});
    const counts = new Map<string, number>();
    for (const r of await ctx.db.find(receipts, { subjectType: "expense" })) counts.set(r.subjectId, (counts.get(r.subjectId) ?? 0) + 1);
    const names = new Map((await ctx.db.find(contacts, { kind: "vendor" })).map((c) => [c.id, c.name]));
    return rows
      .map((e) => ({ ...e, receiptCount: counts.get(e.id) ?? 0, vendorName: e.vendorId ? names.get(e.vendorId) ?? "?" : null }))
      .sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : y.createdAt - x.createdAt));
  },
});

export const get = app.query({
  access: "expenses.read",
  args: { id: s.string() },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const e = await ctx.db.get(expenses, a.id);
    if (!e) return null;
    return { expense: e, receipts: await ctx.db.find(receipts, { subjectId: e.id }), history: await audit.history(ctx as never, "expense", e.id) };
  },
});

// ── Receipts ─────────────────────────────────────────────────────────────────────────────────

async function requireSubject(ctx: Ctx, subjectType: "expense" | "bill", subjectId: string) {
  if (subjectType === "expense") {
    const e = await ctx.db.get(expenses, subjectId);
    if (!e) fail("NOT_FOUND", "No such expense.");
    return e;
  }
  const b = await ctx.db.get(bills, subjectId);
  if (!b) fail("NOT_FOUND", "No such bill.");
  return b;
}

const subjectArgs = { subjectType: s.enum(["expense", "bill"] as const), subjectId: s.string() };

/**
 * A single-use upload link (browser → PUT). The subject is fixed in the file's metadata; FeltKit fixes the
 * organization (a file belongs to the organization it was uploaded in, and is NOT_FOUND from any other).
 */
export const uploadLink = app.mutation({
  access: "expenses.write",
  args: { ...subjectArgs, name: s.string({ minLength: 1, maxLength: 200 }), contentType: s.optional(s.string({ maxLength: 100 })) },
  handler: async (ctx, a) => {
    app.requireTenant(ctx);
    await requireSubject(ctx, a.subjectType, a.subjectId);
    return ctx.services.files.uploadLink({
      name: a.name, ...(a.contentType ? { contentType: a.contentType } : {}), maxBytes: MAX_RECEIPT_BYTES,
      metadata: { subjectType: a.subjectType, subjectId: a.subjectId },
    });
  },
});

async function bind(ctx: MutationCtx, fileId: string) {
  app.requireTenant(ctx);
  const who = actor(ctx);
  let file;
  try {
    // Another organization's file is NOT_FOUND here: FeltKit scopes Files to the caller's organization.
    file = await ctx.services.files.get(fileId);
  } catch {
    fail("NOT_FOUND", "No such file.");
  }
  // Only your own upload is bound (same answer as a missing file, so nothing is revealed).
  const meta = file.metadata as Record<string, unknown>;
  if (file.owner !== who) fail("NOT_FOUND", "No such file.");
  const subjectType = meta.subjectType as "expense" | "bill";
  const subjectId = String(meta.subjectId);
  await requireSubject(ctx, subjectType, subjectId);
  const [existing] = await ctx.db.find(receipts, { fileId });
  if (existing) return existing.id;
  const id = await ctx.db.insert(receipts, {
    subjectType, subjectId, fileId, name: file.name, size: file.size, uploadedBy: who, at: Date.now(),
    ...(file.contentType ? { contentType: file.contentType } : {}), ...(file.checksum ? { checksum: file.checksum } : {}),
  });
  await audit.record(ctx, { subject: "receipt", id, type: "receipt.attached", data: { subjectType, subjectId, fileId, name: file.name, size: file.size, checksum: file.checksum ?? null } });
  await audit.record(ctx, { subject: subjectType, id: subjectId, type: `${subjectType}.receipt.attached`, data: { receiptId: id, name: file.name } });
  return id;
}

/** Bind an uploaded file (from `uploadLink`) to its expense or bill. */
export const attach = app.mutation({
  access: "expenses.write",
  args: { fileId: s.string() },
  handler: (ctx, a) => bind(ctx, a.fileId),
});

/** Server-side upload of a small receipt (base64), for API clients and agents' human operators. */
export const upload = app.mutation({
  access: "expenses.write",
  args: { ...subjectArgs, name: s.string({ minLength: 1, maxLength: 200 }), contentType: s.optional(s.string({ maxLength: 100 })), contentBase64: s.string({ maxLength: 4_000_000 }) },
  handler: async (ctx, a) => {
    app.requireTenant(ctx);
    await requireSubject(ctx, a.subjectType, a.subjectId);
    const bytes = fromBase64(a.contentBase64);
    if (bytes.length === 0) fail("INVALID_ARGUMENT", "The receipt is empty.");
    const file = await ctx.services.files.upload({
      name: a.name, content: bytes, ...(a.contentType ? { contentType: a.contentType } : {}),
      metadata: { subjectType: a.subjectType, subjectId: a.subjectId },
    });
    return bind(ctx, file.id);
  },
});

export const listReceipts = app.query({
  access: "expenses.read",
  args: { subjectId: s.string() },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    return ctx.db.find(receipts, { subjectId: a.subjectId });
  },
});

/** A short-lived download link for a receipt of this organization. */
export const receiptLink = app.query({
  access: "expenses.read",
  args: { receiptId: s.string(), inline: s.optional(s.boolean()) },
  handler: async (ctx, a) => {
    const r = await ctx.db.get(receipts, a.receiptId);
    if (!r) fail("NOT_FOUND", "No such receipt.");
    return ctx.services.files.link(r.fileId, { expiresInSeconds: 300, disposition: a.inline ? "inline" : "attachment" });
  },
});

/** A receipt's bytes (base64) and its stored checksum, through its organization-scoped record. */
export const readReceipt = app.query({
  access: "expenses.read",
  args: { receiptId: s.string() },
  handler: async (ctx, a) => {
    const r = await ctx.db.get(receipts, a.receiptId);
    if (!r) fail("NOT_FOUND", "No such receipt.");
    const { file, bytes } = await ctx.services.files.read(r.fileId);
    return { name: file.name, contentType: file.contentType ?? null, size: file.size, checksum: file.checksum ?? null, contentBase64: toBase64(bytes) };
  },
});
