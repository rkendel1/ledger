/**
 * Payments received from customers and made to vendors.
 *
 *   received: Dr bank/cash · Cr Accounts Receivable, allocated to invoices
 *   made:     Dr Accounts Payable · Cr bank/cash/credit card, allocated to bills
 *
 * A payment is fully applied when recorded (no unapplied credit in this version). Each allocation is
 * checked against the document's open balance, read with a fence, so two concurrent payments can
 * never together over-settle a document. An idempotency key makes a retried request record once.
 */
import { fail, s, type MutationCtx } from "@feltdb/feltkit";
import { accounts, allocations, app, audit, bankMatches, bills, contacts, invoices, ledgerLines, payments } from "./app.js";
import { actor, postEntry, requireDate, requireSettings, reverseEntry, systemAccount, requirePerson } from "./_ledger.js";
import { allocatedTo } from "./_documents.js";

const MONEY_ACCOUNTS = new Set(["cash", "bank", "credit_card"]);

async function moneyAccount(ctx: MutationCtx, id: string, direction: "received" | "made") {
  const acc = await ctx.db.get(accounts, id);
  if (!acc || !MONEY_ACCOUNTS.has(acc.subtype) || (direction === "received" && acc.subtype === "credit_card")) {
    fail("INVALID_ARGUMENT", direction === "received" ? "Deposit into a cash or bank account." : "Pay from a cash, bank or credit-card account.");
  }
  return acc;
}

async function record(ctx: MutationCtx, a: {
  direction: "received" | "made";
  contactId: string;
  date: string;
  amountMinor: number;
  accountId: string;
  applyTo: Array<{ documentId: string; amountMinor: number }>;
  method?: string;
  reference?: string;
  idempotencyKey?: string;
}) {
  if (a.idempotencyKey) {
    const [prior] = await ctx.db.find(payments, { idempotencyKey: a.idempotencyKey });
    if (prior) {
      if (prior.amountMinor !== a.amountMinor || prior.contactId !== a.contactId) fail("CONFLICT", "This idempotency key was used for a different payment.");
      return { id: prior.id, journalEntryId: prior.journalEntryId, replayed: true };
    }
  }
  await requireSettings(ctx);
  const date = requireDate(a.date);
  const kind = a.direction === "received" ? "customer" : "vendor";
  const contact = await ctx.db.get(contacts, a.contactId);
  if (!contact || contact.kind !== kind) fail("INVALID_ARGUMENT", `Unknown ${kind}.`);
  await moneyAccount(ctx, a.accountId, a.direction);
  const applied = a.applyTo.reduce((t, x) => t + x.amountMinor, 0);
  if (applied !== a.amountMinor) fail("INVALID_ARGUMENT", `The payment (${a.amountMinor}) must be fully applied; ${applied} is allocated.`);
  if (new Set(a.applyTo.map((x) => x.documentId)).size !== a.applyTo.length) fail("INVALID_ARGUMENT", "A document is listed twice.");
  const documentType: "invoice" | "bill" = a.direction === "received" ? "invoice" : "bill";
  const docs: Array<{ id: string; label: string; amountMinor: number }> = [];
  for (const x of a.applyTo) {
    if (x.amountMinor <= 0) fail("INVALID_ARGUMENT", "Allocations must be positive.");
    let label: string;
    let total: number;
    if (documentType === "invoice") {
      const inv = await ctx.db.get(invoices, x.documentId);
      if (!inv || inv.customerId !== a.contactId) fail("INVALID_ARGUMENT", "An invoice does not belong to this customer.");
      if (inv.status !== "issued") fail("FAILED_PRECONDITION", `Invoice ${inv.number ?? "(draft)"} is ${inv.status}.`);
      if (date < inv.issueDate) fail("INVALID_ARGUMENT", `The payment is dated before invoice ${inv.number} was issued.`);
      label = inv.number!;
      total = inv.totalMinor;
    } else {
      const bill = await ctx.db.get(bills, x.documentId);
      if (!bill || bill.vendorId !== a.contactId) fail("INVALID_ARGUMENT", "A bill does not belong to this vendor.");
      if (bill.status !== "posted") fail("FAILED_PRECONDITION", `Bill ${bill.billNumber} is ${bill.status}; post it before paying.`);
      if (date < bill.billDate) fail("INVALID_ARGUMENT", `The payment is dated before bill ${bill.billNumber}.`);
      label = bill.billNumber;
      total = bill.totalMinor;
    }
    const open = total - (await allocatedTo(ctx, x.documentId));
    if (x.amountMinor > open) fail("FAILED_PRECONDITION", `${documentType === "invoice" ? "Invoice" : "Bill"} ${label} has ${open} open; ${x.amountMinor} is more than that.`);
    docs.push({ id: x.documentId, label, amountMinor: x.amountMinor });
  }
  const control = await systemAccount(ctx, a.direction === "received" ? "receivable" : "payable");
  const memo = `${a.direction === "received" ? "Payment from" : "Payment to"} ${contact.name}${a.reference ? ` (${a.reference})` : ""}`;
  const entry = await postEntry(ctx, {
    date, description: memo, sourceType: a.direction === "received" ? "payment_received" : "payment_made",
    ...(a.reference ? { reference: a.reference } : {}),
    lines: a.direction === "received"
      ? [{ accountId: a.accountId, debit: a.amountMinor, credit: 0, contactId: contact.id, memo }, { accountId: control.id, debit: 0, credit: a.amountMinor, contactId: contact.id, memo }]
      : [{ accountId: control.id, debit: a.amountMinor, credit: 0, contactId: contact.id, memo }, { accountId: a.accountId, debit: 0, credit: a.amountMinor, contactId: contact.id, memo }],
  });
  const id = await ctx.db.insert(payments, {
    direction: a.direction, contactId: contact.id, date, amountMinor: a.amountMinor, accountId: a.accountId, journalEntryId: entry.id,
    applied: docs.map((d) => ({ documentType, documentId: d.id, amountMinor: d.amountMinor })),
    createdBy: actor(ctx), createdAt: Date.now(),
    ...(a.method ? { method: a.method } : {}), ...(a.reference ? { reference: a.reference } : {}), ...(a.idempotencyKey ? { idempotencyKey: a.idempotencyKey } : {}),
  });
  for (const d of docs) await ctx.db.insert(allocations, { sourceType: "payment", sourceId: id, documentType, documentId: d.id, amountMinor: d.amountMinor, date });
  await audit.record(ctx, { subject: "payment", id, type: `payment.${a.direction}`, data: { contactId: contact.id, amountMinor: a.amountMinor, date, applied: docs, journalEntryId: entry.id } });
  for (const d of docs) await audit.record(ctx, { subject: documentType, id: d.id, type: `${documentType}.payment.applied`, data: { paymentId: id, amountMinor: d.amountMinor } });
  return { id, journalEntryId: entry.id, replayed: false };
}

const applyArg = s.array(s.object({ documentId: s.string(), amountMinor: s.integer({ minimum: 1 }) }), { minItems: 1, maxItems: 100 });
const common = {
  date: s.string(),
  amountMinor: s.integer({ minimum: 1 }),
  accountId: s.string(),
  applyTo: applyArg,
  method: s.optional(s.string({ maxLength: 40 })),
  reference: s.optional(s.string({ maxLength: 120 })),
  idempotencyKey: s.optional(s.string({ minLength: 8, maxLength: 120 })),
};
const paymentOut = s.object({ id: s.string(), journalEntryId: s.string(), replayed: s.boolean() });

export const receive = app.mutation({
  access: "payments.record",
  args: { customerId: s.string(), ...common },
  returns: paymentOut,
  retry: { sequenceConflicts: 3 },
  capability: { name: "payments.receive", description: "Record a customer payment applied to invoices. People only; agents may propose." },
  handler: (ctx, a) => {
    requirePerson(ctx);
    return record(ctx, { ...a, direction: "received", contactId: a.customerId });
  },
});

export const pay = app.mutation({
  access: "payments.record",
  args: { vendorId: s.string(), ...common },
  returns: paymentOut,
  retry: { sequenceConflicts: 3 },
  capability: { name: "payments.pay", description: "Record a payment to a vendor applied to bills. People only; agents may propose." },
  handler: (ctx, a) => {
    requirePerson(ctx);
    return record(ctx, { ...a, direction: "made", contactId: a.vendorId });
  },
});

/**
 * Void a payment recorded in error: posts the reversal, removes its allocations (so the documents
 * reopen) and keeps the payment record with `voidEntryId`. Refused while the payment is matched to a
 * bank transaction: unmatch it first, so a reconciliation never loses its evidence.
 */
export const voidPayment = app.mutation({
  access: "journal.reverse",
  args: { id: s.string(), date: s.string(), reason: s.string({ minLength: 3, maxLength: 500 }) },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, a) => {
    requirePerson(ctx);
    const p = await ctx.db.get(payments, a.id);
    if (!p) fail("NOT_FOUND", "No such payment.");
    if (p.voidEntryId) fail("FAILED_PRECONDITION", "This payment is already void.");
    const lines = await ctx.db.find(ledgerLines, { entryId: p.journalEntryId });
    for (const l of lines) {
      const [m] = await ctx.db.find(bankMatches, { ledgerLineId: l.id });
      if (m) fail("FAILED_PRECONDITION", "This payment is matched to a bank transaction. Unmatch it first.");
    }
    const reversal = await reverseEntry(ctx, p.journalEntryId, { date: requireDate(a.date), reason: `Void payment: ${a.reason}`, sourceType: p.direction === "received" ? "payment_received" : "payment_made", sourceId: p.id });
    const allocs = await ctx.db.find(allocations, { sourceId: p.id });
    for (const x of allocs) await ctx.db.delete(allocations, x.id);
    await ctx.db.patch(payments, p.id, { voidEntryId: reversal.id, voidReason: a.reason });
    await audit.record(ctx, { subject: "payment", id: p.id, type: "payment.voided", data: { reason: a.reason, journalEntryId: reversal.id, released: allocs.map((x) => ({ documentId: x.documentId, amountMinor: x.amountMinor })) } });
    return { ok: true, journalEntryId: reversal.id };
  },
});

export const list = app.query({
  access: "invoices.read",
  args: { direction: s.optional(s.enum(["received", "made"] as const)), contactId: s.optional(s.string()) },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const names = new Map((await ctx.db.find(contacts, {})).map((c) => [c.id, c.name]));
    return (await ctx.db.find(payments, a.direction ? { direction: a.direction } : {}))
      .filter((p) => !a.contactId || p.contactId === a.contactId)
      .map((p) => ({ ...p, contactName: names.get(p.contactId) ?? "?" }))
      .sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : y.createdAt - x.createdAt));
  },
});
