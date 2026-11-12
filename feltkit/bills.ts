/**
 * Bills and accounts payable.
 *
 *   draft    — captured, editable; approvers are notified it awaits approval
 *   approved — an accountant (bills.approve) has approved it; no accounting effect yet
 *   posted   — Dr each expense/asset line · Cr Accounts Payable (bills.post)
 *   void     — a posted bill with nothing paid: the exact reversal is posted
 */
import { fail, s, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { accounts, allocations, app, audit, bills, contacts, receipts } from "./app.js";
import { actor, addDays, postEntry, requireDate, requireSettings, reverseEntry, systemAccount, today } from "./_ledger.js";
import { allocatedByDocument, allocatedTo, billState } from "./_documents.js";

type Ctx = QueryCtx | MutationCtx;

const lineArg = s.object({ description: s.string({ minLength: 1, maxLength: 300 }), accountId: s.string(), amountMinor: s.integer({ minimum: 1 }) });

async function checkLines(ctx: Ctx, lines: ReadonlyArray<{ accountId: string; amountMinor: number }>) {
  for (const [i, l] of lines.entries()) {
    const acc = await ctx.db.get(accounts, l.accountId);
    if (!acc) fail("INVALID_ARGUMENT", `Line ${i + 1}: unknown account.`);
    if (!(acc.type === "expense" || (acc.type === "asset" && (acc.subtype === "other_current_asset" || acc.subtype === "fixed_asset")))) {
      fail("INVALID_ARGUMENT", `Line ${i + 1}: a bill line is an expense, a prepaid expense or a fixed asset, not ${acc.name}.`);
    }
    if (!acc.active) fail("FAILED_PRECONDITION", `Line ${i + 1}: ${acc.name} is inactive.`);
  }
  const total = lines.reduce((t, l) => t + l.amountMinor, 0);
  if (!Number.isSafeInteger(total)) fail("INVALID_ARGUMENT", "The bill total is too large.");
  return total;
}

async function vendor(ctx: Ctx, id: string) {
  const v = await ctx.db.get(contacts, id);
  if (!v || v.kind !== "vendor") fail("INVALID_ARGUMENT", "Unknown vendor.");
  return v;
}

/** Notify everyone who can approve bills, after the capture commits. */
async function notifyApprovers(ctx: MutationCtx, billId: string, title: string) {
  const me = actor(ctx);
  for (const m of await ctx.tenancy.members()) {
    if (m.principalId !== me && ["owner", "admin", "accountant"].includes(m.role)) {
      ctx.afterCommit.notifications.send({ recipient: m.principalId, type: "bill.awaiting_approval", title, data: { billId } });
    }
  }
}

export const create = app.mutation({
  access: "bills.write",
  args: { vendorId: s.string(), billNumber: s.string({ minLength: 1, maxLength: 80 }), billDate: s.string(), dueDate: s.optional(s.string()), lines: s.array(lineArg, { minItems: 1, maxItems: 200 }), memo: s.optional(s.string({ maxLength: 1000 })) },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const v = await vendor(ctx, a.vendorId);
    const billDate = requireDate(a.billDate, "billDate");
    const dueDate = a.dueDate ? requireDate(a.dueDate, "dueDate") : addDays(billDate, v.paymentTermsDays);
    if (dueDate < billDate) fail("INVALID_ARGUMENT", "The due date is before the bill date.");
    const billNumber = a.billNumber.trim();
    const [dup] = await ctx.db.find(bills, { vendorId: a.vendorId, billNumber });
    if (dup) fail("CONFLICT", `${v.name} bill ${billNumber} is already recorded.`);
    const totalMinor = await checkLines(ctx, a.lines);
    const id = await ctx.db.insert(bills, {
      vendorId: a.vendorId, billNumber, billDate, dueDate, status: "draft", totalMinor, createdBy: actor(ctx), createdAt: Date.now(),
      lines: a.lines.map((l) => ({ description: l.description.trim(), accountId: l.accountId, amountMinor: l.amountMinor })),
      ...(a.memo ? { memo: a.memo } : {}),
    });
    await audit.record(ctx, { subject: "bill", id, type: "bill.captured", data: { vendorId: a.vendorId, billNumber, totalMinor } });
    await notifyApprovers(ctx, id, `${v.name} bill ${billNumber} awaits approval`);
    return id;
  },
});

export const update = app.mutation({
  access: "bills.write",
  args: { id: s.string(), billDate: s.string(), dueDate: s.string(), lines: s.array(lineArg, { minItems: 1, maxItems: 200 }), memo: s.optional(s.string({ maxLength: 1000 })) },
  handler: async (ctx, a) => {
    const bill = await ctx.db.get(bills, a.id);
    if (!bill) fail("NOT_FOUND", "No such bill.");
    if (bill.status !== "draft") fail("FAILED_PRECONDITION", `This bill is ${bill.status}; only a draft can be edited.`);
    requireDate(a.billDate, "billDate");
    requireDate(a.dueDate, "dueDate");
    const totalMinor = await checkLines(ctx, a.lines);
    await ctx.db.patch(bills, a.id, { billDate: a.billDate, dueDate: a.dueDate, lines: a.lines.map((l) => ({ ...l })), totalMinor, ...(a.memo !== undefined ? { memo: a.memo } : {}) });
    await audit.record(ctx, { subject: "bill", id: a.id, type: "bill.draft.updated", data: { totalMinor } });
    return { ok: true };
  },
});

export const approve = app.mutation({
  access: "bills.approve",
  approval: "required",
  args: { id: s.string(), note: s.optional(s.string({ maxLength: 500 })) },
  handler: async (ctx, a) => {
    const bill = await ctx.db.get(bills, a.id);
    if (!bill) fail("NOT_FOUND", "No such bill.");
    if (bill.status !== "draft") fail("FAILED_PRECONDITION", `This bill is already ${bill.status}.`);
    await checkLines(ctx, bill.lines);
    await ctx.db.patch(bills, a.id, { status: "approved", approvedBy: actor(ctx), approvedAt: Date.now() });
    await audit.record(ctx, { subject: "bill", id: a.id, type: "bill.approved", data: { totalMinor: bill.totalMinor, ...(a.note ? { note: a.note } : {}) } });
    return { ok: true };
  },
});

export const post = app.mutation({
  access: "bills.post",
  approval: "required",
  args: { id: s.string() },
  returns: s.object({ journalEntryId: s.string() }),
  retry: { sequenceConflicts: 3 },
  capability: { name: "bills.post", description: "Post an approved bill to accounts payable. People only; agents may propose." },
  handler: async (ctx, a) => {
    const bill = await ctx.db.get(bills, a.id);
    if (!bill) fail("NOT_FOUND", "No such bill.");
    if (bill.status === "draft") fail("FAILED_PRECONDITION", "This bill must be approved before it is posted.");
    if (bill.status !== "approved") fail("FAILED_PRECONDITION", `This bill is already ${bill.status}.`);
    const v = await vendor(ctx, bill.vendorId);
    const ap = await systemAccount(ctx, "payable");
    const memo = `${v.name} bill ${bill.billNumber}`;
    const debits = new Map<string, number>();
    for (const l of bill.lines) debits.set(l.accountId, (debits.get(l.accountId) ?? 0) + l.amountMinor);
    const entry = await postEntry(ctx, {
      date: bill.billDate, description: memo, reference: bill.billNumber, sourceType: "bill", sourceId: bill.id,
      ...(bill.approvedBy ? { approvedBy: bill.approvedBy } : {}),
      lines: [...[...debits.entries()].map(([accountId, amount]) => ({ accountId, debit: amount, credit: 0, contactId: v.id, memo })), { accountId: ap.id, debit: 0, credit: bill.totalMinor, contactId: v.id, memo }],
    });
    await ctx.db.patch(bills, a.id, { status: "posted", journalEntryId: entry.id });
    await audit.record(ctx, { subject: "bill", id: a.id, type: "bill.posted", data: { journalEntryId: entry.id, totalMinor: bill.totalMinor } });
    return { journalEntryId: entry.id };
  },
});

export const voidBill = app.mutation({
  access: "bills.approve",
  approval: "required",
  args: { id: s.string(), date: s.string(), reason: s.string({ minLength: 3, maxLength: 500 }) },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, a) => {
    const bill = await ctx.db.get(bills, a.id);
    if (!bill) fail("NOT_FOUND", "No such bill.");
    if (bill.status === "draft" || bill.status === "approved") {
      await ctx.db.patch(bills, a.id, { status: "void" });
      await audit.record(ctx, { subject: "bill", id: a.id, type: "bill.voided", data: { reason: a.reason, posted: false } });
      return { ok: true };
    }
    if (bill.status !== "posted") fail("FAILED_PRECONDITION", "This bill is already void.");
    if ((await allocatedTo(ctx, bill.id)) > 0) fail("FAILED_PRECONDITION", "This bill has payments applied. Void those first.");
    const reversal = await reverseEntry(ctx, bill.journalEntryId!, { date: requireDate(a.date), reason: `Void bill ${bill.billNumber}: ${a.reason}`, sourceType: "bill", sourceId: bill.id });
    await ctx.db.patch(bills, a.id, { status: "void", voidEntryId: reversal.id });
    await audit.record(ctx, { subject: "bill", id: a.id, type: "bill.voided", data: { reason: a.reason, posted: true, journalEntryId: reversal.id } });
    return { ok: true };
  },
});

export const list = app.query({
  access: "bills.read",
  args: { vendorId: s.optional(s.string()), asOf: s.optional(s.string()) },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const asOf = a.asOf ?? today();
    const alloc = await allocatedByDocument(ctx, "bill");
    const names = new Map((await ctx.db.find(contacts, { kind: "vendor" })).map((c) => [c.id, c.name]));
    return (await ctx.db.find(bills, a.vendorId ? { vendorId: a.vendorId } : {}))
      .map((b) => ({ ...b, vendorName: names.get(b.vendorId) ?? "?", ...billState(b, alloc.get(b.id), asOf) }))
      .sort((x, y) => (x.billDate < y.billDate ? 1 : x.billDate > y.billDate ? -1 : y.createdAt - x.createdAt));
  },
});

export const get = app.query({
  access: "bills.read",
  args: { id: s.string() },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const bill = await ctx.db.get(bills, a.id);
    if (!bill) return null;
    const allocs = await ctx.db.find(allocations, { documentId: bill.id });
    return {
      bill,
      vendor: await ctx.db.get(contacts, bill.vendorId),
      ...billState(bill, { paid: allocs.reduce((t, x) => t + x.amountMinor, 0) }, today()),
      allocations: allocs,
      receipts: await ctx.db.find(receipts, { subjectId: bill.id }),
      history: await audit.history(ctx as never, "bill", bill.id),
    };
  },
});
