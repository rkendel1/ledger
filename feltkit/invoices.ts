/**
 * Invoicing and accounts receivable.
 *
 *   draft  — editable, numberless, no accounting effect
 *   issue  — numbered; posts Dr Accounts Receivable / Cr revenue (and Cr sales tax)
 *   payments and credit notes settle it (payments.ts, creditNote below); paid, partially paid and
 *   overdue are derived, never stored
 *   void   — only with nothing applied; posts the exact reversal of the issue entry
 */
import { fail, s, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { accounts, allocations, app, audit, contacts, creditNotes, invoices, taxRates } from "./app.js";
import { actor, addDays, postEntry, requireDate, requireSettings, reverseEntry, systemAccount, today, type LineInput } from "./_ledger.js";
import { allocatedByDocument, allocatedTo, invoiceState } from "./_documents.js";

type Ctx = QueryCtx | MutationCtx;

const lineArg = s.object({
  description: s.string({ minLength: 1, maxLength: 300 }),
  quantityMilli: s.integer({ minimum: 1, maximum: 1_000_000_000 }),
  unitPriceMinor: s.integer({ minimum: 0, maximum: 100_000_000_000 }),
  accountId: s.string(),
  taxRateId: s.optional(s.string()),
});

/** Line amount = quantity × unit price, rounded half up to the minor unit. Tax likewise, per line. */
export function lineAmount(quantityMilli: number, unitPriceMinor: number): number {
  const product = quantityMilli * unitPriceMinor;
  if (!Number.isSafeInteger(product)) fail("INVALID_ARGUMENT", "A line amount is too large.");
  return Math.floor((product + 500) / 1000);
}

export function taxOn(amountMinor: number, rateBp: number): number {
  return Math.floor((amountMinor * rateBp + 5000) / 10000);
}

async function priceLines(ctx: Ctx, lines: ReadonlyArray<{ description: string; quantityMilli: number; unitPriceMinor: number; accountId: string; taxRateId?: string }>) {
  const priced = [];
  for (const [i, l] of lines.entries()) {
    const account = await ctx.db.get(accounts, l.accountId);
    if (!account) fail("INVALID_ARGUMENT", `Line ${i + 1}: unknown account.`);
    if (account.type !== "revenue") fail("INVALID_ARGUMENT", `Line ${i + 1}: ${account.name} is not a revenue account.`);
    if (!account.active) fail("FAILED_PRECONDITION", `Line ${i + 1}: ${account.name} is inactive.`);
    let taxMinor = 0;
    const amountMinor = lineAmount(l.quantityMilli, l.unitPriceMinor);
    if (l.taxRateId) {
      const rate = await ctx.db.get(taxRates, l.taxRateId);
      if (!rate || !rate.active) fail("INVALID_ARGUMENT", `Line ${i + 1}: unknown or inactive tax rate.`);
      taxMinor = taxOn(amountMinor, rate.rateBp);
    }
    priced.push({ description: l.description.trim(), quantityMilli: l.quantityMilli, unitPriceMinor: l.unitPriceMinor, accountId: l.accountId, amountMinor, taxMinor, ...(l.taxRateId ? { taxRateId: l.taxRateId } : {}) });
  }
  const subtotalMinor = priced.reduce((t, l) => t + l.amountMinor, 0);
  const taxMinor = priced.reduce((t, l) => t + l.taxMinor, 0);
  return { lines: priced, subtotalMinor, taxMinor, totalMinor: subtotalMinor + taxMinor };
}

async function requireContact(ctx: Ctx, id: string, kind: "customer" | "vendor") {
  const c = await ctx.db.get(contacts, id);
  if (!c || c.kind !== kind) fail("INVALID_ARGUMENT", `Unknown ${kind}.`);
  if (!c.active) fail("FAILED_PRECONDITION", `${c.name} is inactive.`);
  return c;
}

export const create = app.mutation({
  access: "invoices.write",
  args: { customerId: s.string(), issueDate: s.string(), dueDate: s.optional(s.string()), lines: s.array(lineArg, { minItems: 1, maxItems: 200 }), memo: s.optional(s.string({ maxLength: 1000 })) },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const customer = await requireContact(ctx, a.customerId, "customer");
    const issueDate = requireDate(a.issueDate, "issueDate");
    const dueDate = a.dueDate ? requireDate(a.dueDate, "dueDate") : addDays(issueDate, customer.paymentTermsDays);
    if (dueDate < issueDate) fail("INVALID_ARGUMENT", "The due date is before the issue date.");
    const priced = await priceLines(ctx, a.lines);
    const id = await ctx.db.insert(invoices, {
      customerId: a.customerId, issueDate, dueDate, status: "draft", ...priced, createdBy: actor(ctx), createdAt: Date.now(),
      ...(a.memo ? { memo: a.memo } : {}),
    });
    await audit.record(ctx, { subject: "invoice", id, type: "invoice.drafted", data: { customerId: a.customerId, totalMinor: priced.totalMinor } });
    return id;
  },
});

export const update = app.mutation({
  access: "invoices.write",
  args: { id: s.string(), customerId: s.string(), issueDate: s.string(), dueDate: s.string(), lines: s.array(lineArg, { minItems: 1, maxItems: 200 }), memo: s.optional(s.string({ maxLength: 1000 })) },
  handler: async (ctx, a) => {
    const inv = await ctx.db.get(invoices, a.id);
    if (!inv) fail("NOT_FOUND", "No such invoice.");
    if (inv.status !== "draft") fail("FAILED_PRECONDITION", `Invoice ${inv.number} is ${inv.status}. Issued invoices cannot be edited; use a credit note or void it.`);
    await requireContact(ctx, a.customerId, "customer");
    requireDate(a.issueDate, "issueDate");
    requireDate(a.dueDate, "dueDate");
    if (a.dueDate < a.issueDate) fail("INVALID_ARGUMENT", "The due date is before the issue date.");
    const priced = await priceLines(ctx, a.lines);
    await ctx.db.patch(invoices, a.id, { customerId: a.customerId, issueDate: a.issueDate, dueDate: a.dueDate, ...priced, ...(a.memo !== undefined ? { memo: a.memo } : {}) });
    await audit.record(ctx, { subject: "invoice", id: a.id, type: "invoice.draft.updated", data: { totalMinor: priced.totalMinor } });
    return { ok: true };
  },
});

export const deleteDraft = app.mutation({
  access: "invoices.write",
  args: { id: s.string() },
  handler: async (ctx, a) => {
    const inv = await ctx.db.get(invoices, a.id);
    if (!inv) fail("NOT_FOUND", "No such invoice.");
    if (inv.status !== "draft") fail("FAILED_PRECONDITION", "Only a draft can be deleted.");
    await ctx.db.delete(invoices, a.id);
    await audit.record(ctx, { subject: "invoice", id: a.id, type: "invoice.draft.deleted", data: { totalMinor: inv.totalMinor } });
    return { ok: true };
  },
});

/** The accounting effect of an invoice: Dr AR total; Cr each revenue account; Cr each tax account. */
async function issueLines(ctx: Ctx, inv: { customerId: string; lines: Array<{ accountId: string; amountMinor: number; taxMinor: number; taxRateId?: string }>; totalMinor: number }, ar: string, memo: string): Promise<LineInput[]> {
  const credits = new Map<string, number>();
  for (const l of inv.lines) {
    if (l.amountMinor) credits.set(l.accountId, (credits.get(l.accountId) ?? 0) + l.amountMinor);
    if (l.taxMinor) {
      const rate = await ctx.db.get(taxRates, l.taxRateId!);
      if (!rate) fail("FAILED_PRECONDITION", "A tax rate on this invoice no longer exists.");
      credits.set(rate.accountId, (credits.get(rate.accountId) ?? 0) + l.taxMinor);
    }
  }
  return [
    { accountId: ar, debit: inv.totalMinor, credit: 0, contactId: inv.customerId, memo },
    ...[...credits.entries()].map(([accountId, amount]) => ({ accountId, debit: 0, credit: amount, contactId: inv.customerId, memo })),
  ];
}

export const issue = app.mutation({
  access: "invoices.issue",
  approval: "required",
  args: { id: s.string() },
  returns: s.object({ id: s.string(), number: s.string(), journalEntryId: s.string() }),
  retry: { sequenceConflicts: 3 },
  capability: { name: "invoices.issue", description: "Issue a draft invoice: number it and post it to receivables. People only; agents may propose." },
  handler: async (ctx, a) => {
    const tenant = app.requireTenant(ctx);
    const inv = await ctx.db.get(invoices, a.id);
    if (!inv) fail("NOT_FOUND", "No such invoice.");
    if (inv.status !== "draft") fail("FAILED_PRECONDITION", `Invoice ${inv.number} is already ${inv.status}.`);
    if (inv.totalMinor <= 0) fail("FAILED_PRECONDITION", "An invoice must total more than zero.");
    await requireContact(ctx, inv.customerId, "customer");
    const priced = await priceLines(ctx, inv.lines);
    if (priced.totalMinor !== inv.totalMinor) fail("FAILED_PRECONDITION", "A tax rate changed since the draft was saved. Re-save the draft to reprice it.");
    const number = `INV-${String(await ctx.db.sequence(`invoice:${tenant.id}`)).padStart(4, "0")}`;
    const ar = await systemAccount(ctx, "receivable");
    const entry = await postEntry(ctx, {
      date: inv.issueDate, description: `Invoice ${number}`, reference: number, sourceType: "invoice", sourceId: inv.id,
      lines: await issueLines(ctx, inv, ar.id, `Invoice ${number}`),
    });
    await ctx.db.patch(invoices, inv.id, { status: "issued", number, journalEntryId: entry.id, issuedBy: actor(ctx) });
    await audit.record(ctx, { subject: "invoice", id: inv.id, type: "invoice.issued", data: { number, totalMinor: inv.totalMinor, journalEntryId: entry.id } });
    return { id: inv.id, number, journalEntryId: entry.id };
  },
});

export const voidInvoice = app.mutation({
  access: "invoices.void",
  approval: "required",
  args: { id: s.string(), date: s.string(), reason: s.string({ minLength: 3, maxLength: 500 }) },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, a) => {
    const inv = await ctx.db.get(invoices, a.id);
    if (!inv) fail("NOT_FOUND", "No such invoice.");
    if (inv.status !== "issued") fail("FAILED_PRECONDITION", `Only an issued invoice can be voided (this one is ${inv.status}).`);
    if ((await allocatedTo(ctx, inv.id)) > 0) fail("FAILED_PRECONDITION", `Invoice ${inv.number} has payments or credits applied. Void those first, or issue a credit note for the rest.`);
    const reversal = await reverseEntry(ctx, inv.journalEntryId!, { date: requireDate(a.date), reason: `Void invoice ${inv.number}: ${a.reason}`, sourceType: "invoice", sourceId: inv.id });
    await ctx.db.patch(invoices, inv.id, { status: "void", voidEntryId: reversal.id });
    await audit.record(ctx, { subject: "invoice", id: inv.id, type: "invoice.voided", data: { number: inv.number, reason: a.reason, journalEntryId: reversal.id } });
    return { ok: true, journalEntryId: reversal.id };
  },
});

/**
 * A credit note against an issued invoice: reduces revenue (and tax) and the invoice's balance.
 * Posts Dr revenue / Dr tax / Cr Accounts Receivable, and allocates the credit to the invoice.
 */
export const creditNote = app.mutation({
  access: "invoices.issue",
  approval: "required",
  args: {
    invoiceId: s.string(),
    date: s.string(),
    reason: s.string({ minLength: 3, maxLength: 500 }),
    lines: s.array(s.object({ description: s.string({ minLength: 1, maxLength: 300 }), accountId: s.string(), amountMinor: s.integer({ minimum: 1 }), taxRateId: s.optional(s.string()) }), { minItems: 1, maxItems: 50 }),
  },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, a) => {
    const tenant = app.requireTenant(ctx);
    const inv = await ctx.db.get(invoices, a.invoiceId);
    if (!inv) fail("NOT_FOUND", "No such invoice.");
    if (inv.status !== "issued") fail("FAILED_PRECONDITION", "A credit note applies to an issued invoice.");
    const date = requireDate(a.date);
    if (date < inv.issueDate) fail("INVALID_ARGUMENT", "A credit note cannot be dated before its invoice.");
    const lines = [];
    for (const l of a.lines) {
      const acc = await ctx.db.get(accounts, l.accountId);
      if (!acc || acc.type !== "revenue") fail("INVALID_ARGUMENT", "Credit note lines reduce a revenue account.");
      let taxMinor = 0;
      let taxAccountId: string | undefined;
      if (l.taxRateId) {
        const rate = await ctx.db.get(taxRates, l.taxRateId);
        if (!rate) fail("INVALID_ARGUMENT", "Unknown tax rate.");
        taxMinor = taxOn(l.amountMinor, rate.rateBp);
        taxAccountId = rate.accountId;
      }
      lines.push({ description: l.description, accountId: l.accountId, amountMinor: l.amountMinor, taxMinor, taxAccountId });
    }
    const totalMinor = lines.reduce((t, l) => t + l.amountMinor + l.taxMinor, 0);
    const balance = inv.totalMinor - (await allocatedTo(ctx, inv.id));
    if (totalMinor > balance) fail("FAILED_PRECONDITION", `The credit (${totalMinor}) exceeds the invoice's open balance (${balance}).`);
    const number = `CN-${String(await ctx.db.sequence(`creditnote:${tenant.id}`)).padStart(4, "0")}`;
    const ar = await systemAccount(ctx, "receivable");
    const debits = new Map<string, number>();
    for (const l of lines) {
      debits.set(l.accountId, (debits.get(l.accountId) ?? 0) + l.amountMinor);
      if (l.taxMinor) debits.set(l.taxAccountId!, (debits.get(l.taxAccountId!) ?? 0) + l.taxMinor);
    }
    const memo = `Credit note ${number} for ${inv.number}`;
    const entry = await postEntry(ctx, {
      date, description: memo, reference: number, sourceType: "credit_note", reason: a.reason,
      lines: [...[...debits.entries()].map(([accountId, amount]) => ({ accountId, debit: amount, credit: 0, contactId: inv.customerId, memo })), { accountId: ar.id, debit: 0, credit: totalMinor, contactId: inv.customerId, memo }],
    });
    const id = await ctx.db.insert(creditNotes, {
      number, invoiceId: inv.id, customerId: inv.customerId, date, reason: a.reason, totalMinor, journalEntryId: entry.id, createdBy: actor(ctx), createdAt: Date.now(),
      lines: lines.map((l) => ({ description: l.description, accountId: l.accountId, amountMinor: l.amountMinor, taxMinor: l.taxMinor })),
    });
    await ctx.db.insert(allocations, { sourceType: "credit_note", sourceId: id, documentType: "invoice", documentId: inv.id, amountMinor: totalMinor, date });
    await audit.record(ctx, { subject: "invoice", id: inv.id, type: "invoice.credited", data: { creditNote: number, creditNoteId: id, totalMinor, reason: a.reason, journalEntryId: entry.id } });
    return { id, number, journalEntryId: entry.id };
  },
});

export const list = app.query({
  access: "invoices.read",
  args: { customerId: s.optional(s.string()), asOf: s.optional(s.string()) },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const asOf = a.asOf ?? today();
    const alloc = await allocatedByDocument(ctx, "invoice");
    const names = new Map((await ctx.db.find(contacts, { kind: "customer" })).map((c) => [c.id, c.name]));
    return (await ctx.db.find(invoices, a.customerId ? { customerId: a.customerId } : {}))
      .map((i) => ({ ...i, customerName: names.get(i.customerId) ?? "?", ...invoiceState(i, alloc.get(i.id), asOf) }))
      .sort((x, y) => (x.issueDate === y.issueDate ? (y.number ?? "").localeCompare(x.number ?? "") : x.issueDate < y.issueDate ? 1 : -1));
  },
});

export const get = app.query({
  access: "invoices.read",
  args: { id: s.string() },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const inv = await ctx.db.get(invoices, a.id);
    if (!inv) return null;
    const allocs = await ctx.db.find(allocations, { documentId: inv.id });
    const paid = allocs.filter((x) => x.sourceType === "payment").reduce((t, x) => t + x.amountMinor, 0);
    const credited = allocs.filter((x) => x.sourceType === "credit_note").reduce((t, x) => t + x.amountMinor, 0);
    const customer = await ctx.db.get(contacts, inv.customerId);
    const notes = await ctx.db.find(creditNotes, { invoiceId: inv.id });
    return {
      invoice: inv,
      customer,
      ...invoiceState(inv, { paid, credited }, today()),
      allocations: allocs,
      creditNotes: notes,
      history: await audit.history(ctx as never, "invoice", inv.id),
    };
  },
});

export const listTaxRates = app.query({
  access: "invoices.read",
  handler: async (ctx) => {
    await requireSettings(ctx);
    return ctx.db.find(taxRates, {});
  },
});

export const createTaxRate = app.mutation({
  access: "accounts.write",
  args: { name: s.string({ minLength: 1, maxLength: 80 }), rateBp: s.integer({ minimum: 0, maximum: 10000 }), accountId: s.string() },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const acc = await ctx.db.get(accounts, a.accountId);
    if (!acc || acc.subtype !== "tax_payable") fail("INVALID_ARGUMENT", "Tax is collected into a tax-payable liability account.");
    const id = await ctx.db.insert(taxRates, { name: a.name.trim(), rateBp: a.rateBp, accountId: a.accountId, active: true });
    await audit.record(ctx, { subject: "account", id, type: "taxrate.created", data: { name: a.name, rateBp: a.rateBp } });
    return id;
  },
});
