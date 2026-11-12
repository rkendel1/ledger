/**
 * M1 — core business accounting: customers, vendors, invoices, credit notes, payments, bills,
 * expenses and receipts, each checked against the journal entries it must produce.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../feltkit/_generated/api.js";
import { assertIntegrity, newOrg, rejectsWith, withApp, type Org } from "./_helpers.js";

async function balances(org: Org) {
  return Object.fromEntries((await org.reviewer.query(api.accounts.list, {})).map((a) => [a.number, a.balanceMinor]));
}

async function customerAndInvoice(org: Org) {
  const customer = await org.bookkeeper.mutation(api.contacts.create, { kind: "customer", name: "Northwind", email: "ap@northwind.test", paymentTermsDays: 15 });
  const [rate] = await org.reviewer.query(api.invoices.listTaxRates, {});
  const id = await org.bookkeeper.mutation(api.invoices.create, {
    customerId: customer,
    issueDate: "2026-03-01",
    lines: [
      { description: "Consulting", quantityMilli: 1500, unitPriceMinor: 3333, accountId: org.acct["4000"]!, taxRateId: rate!.id }, // 1.5 × 33.33 = 49.995 → 50.00; tax 8% = 4.00
      { description: "Workshop", quantityMilli: 1000, unitPriceMinor: 100000, accountId: org.acct["4000"]! }, // 1000.00, untaxed
    ],
  });
  return { customer, id };
}

test("invoice: draft has no effect; issuing numbers it and posts AR/revenue/tax; issued invoices are immutable", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const { id } = await customerAndInvoice(org);
    const draft = await org.reviewer.query(api.invoices.get, { id });
    assert.equal(draft!.invoice.subtotalMinor, 105000);
    assert.equal(draft!.invoice.taxMinor, 400);
    assert.equal(draft!.invoice.totalMinor, 105400);
    assert.equal(draft!.invoice.dueDate, "2026-03-16", "due date from the customer's terms");
    assert.equal(draft!.invoice.number, undefined);
    assert.ok(Object.values(await balances(org)).every((b) => b === 0));
    await rejectsWith(org.reviewer.mutation(api.invoices.issue, { id }), "FORBIDDEN");
    await rejectsWith(org.agent.mutation(api.invoices.issue, { id }), "FORBIDDEN");
    const issued = await org.bookkeeper.mutation(api.invoices.issue, { id });
    assert.equal(issued.number, "INV-0001");
    const b = await balances(org);
    assert.deepEqual([b["1100"], b["4000"], b["2200"]], [105400, 105000, 400]);
    const je = await org.reviewer.query(api.journal.get, { id: issued.journalEntryId });
    assert.equal(je!.entry.sourceType, "invoice");
    assert.equal(je!.entry.sourceId, id);
    await rejectsWith(org.bookkeeper.mutation(api.invoices.issue, { id }), "FAILED_PRECONDITION");
    await rejectsWith(org.bookkeeper.mutation(api.invoices.update, { id, customerId: draft!.invoice.customerId, issueDate: "2026-03-01", dueDate: "2026-03-30", lines: [{ description: "x", quantityMilli: 1000, unitPriceMinor: 1, accountId: org.acct["4000"]! }] }), "FAILED_PRECONDITION");
    await rejectsWith(org.accountant.mutation(api.journal.reverse, { id: issued.journalEntryId, date: "2026-03-02", reason: "sneaky" }), "FAILED_PRECONDITION", /void, credit note/);
    await assertIntegrity(org);
  }));

test("payments: partial then full payment settle the invoice through AR; over-payment is refused, even concurrently", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const { customer, id } = await customerAndInvoice(org);
    await org.bookkeeper.mutation(api.invoices.issue, { id });
    const bank = org.acct["1010"]!;
    await rejectsWith(org.bookkeeper.mutation(api.payments.receive, { customerId: customer, date: "2026-03-05", amountMinor: 200000, accountId: bank, applyTo: [{ documentId: id, amountMinor: 200000 }] }), "FAILED_PRECONDITION", /open/);
    await rejectsWith(org.bookkeeper.mutation(api.payments.receive, { customerId: customer, date: "2026-03-05", amountMinor: 50000, accountId: bank, applyTo: [{ documentId: id, amountMinor: 40000 }] }), "INVALID_ARGUMENT", /fully applied/);
    await rejectsWith(org.bookkeeper.mutation(api.payments.receive, { customerId: customer, date: "2026-02-05", amountMinor: 100, accountId: bank, applyTo: [{ documentId: id, amountMinor: 100 }] }), "INVALID_ARGUMENT", /before invoice/);
    await rejectsWith(org.reviewer.mutation(api.payments.receive, { customerId: customer, date: "2026-03-05", amountMinor: 100, accountId: bank, applyTo: [{ documentId: id, amountMinor: 100 }] }), "FORBIDDEN");
    await org.bookkeeper.mutation(api.payments.receive, { customerId: customer, date: "2026-03-05", amountMinor: 50000, accountId: bank, applyTo: [{ documentId: id, amountMinor: 50000 }], idempotencyKey: "pay-northwind-1" });
    let inv = await org.reviewer.query(api.invoices.get, { id });
    assert.equal(inv!.derivedStatus === "partially_paid" || inv!.derivedStatus === "overdue", true);
    assert.equal(inv!.balanceMinor, 55400);
    // Retried request: no second payment.
    const again = await org.bookkeeper.mutation(api.payments.receive, { customerId: customer, date: "2026-03-05", amountMinor: 50000, accountId: bank, applyTo: [{ documentId: id, amountMinor: 50000 }], idempotencyKey: "pay-northwind-1" });
    assert.equal(again.replayed, true);
    // Two concurrent payments each for the full remainder: at most one may succeed.
    const race = await Promise.allSettled([1, 2, 3].map(() => org.bookkeeper.mutation(api.payments.receive, { customerId: customer, date: "2026-03-20", amountMinor: 55400, accountId: bank, applyTo: [{ documentId: id, amountMinor: 55400 }] })));
    assert.ok(race.filter((r) => r.status === "fulfilled").length <= 1);
    if (!race.some((r) => r.status === "fulfilled")) await org.bookkeeper.mutation(api.payments.receive, { customerId: customer, date: "2026-03-20", amountMinor: 55400, accountId: bank, applyTo: [{ documentId: id, amountMinor: 55400 }] });
    inv = await org.reviewer.query(api.invoices.get, { id });
    assert.equal(inv!.derivedStatus, "paid");
    assert.equal(inv!.balanceMinor, 0);
    const b = await balances(org);
    assert.deepEqual([b["1100"], b["1010"]], [0, 105400]);
    await rejectsWith(org.accountant.mutation(api.invoices.voidInvoice, { id, date: "2026-03-21", reason: "oops" }), "FAILED_PRECONDITION", /payments or credits/);
    await assertIntegrity(org);
  }));

test("credit notes reduce revenue, tax and the invoice balance; voiding a payment reopens the invoice", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const { customer, id } = await customerAndInvoice(org);
    await org.bookkeeper.mutation(api.invoices.issue, { id });
    const [rate] = await org.reviewer.query(api.invoices.listTaxRates, {});
    await rejectsWith(org.bookkeeper.mutation(api.invoices.creditNote, { invoiceId: id, date: "2026-03-02", reason: "too much", lines: [{ description: "x", accountId: org.acct["4000"]!, amountMinor: 200000 }] }), "FAILED_PRECONDITION", /exceeds/);
    const cn = await org.bookkeeper.mutation(api.invoices.creditNote, { invoiceId: id, date: "2026-03-02", reason: "Consulting discount", lines: [{ description: "Discount", accountId: org.acct["4000"]!, amountMinor: 5000, taxRateId: rate!.id }] });
    assert.equal(cn.number, "CN-0001");
    const inv = await org.reviewer.query(api.invoices.get, { id });
    assert.equal(inv!.creditedMinor, 5400);
    assert.equal(inv!.balanceMinor, 100000);
    let b = await balances(org);
    assert.deepEqual([b["1100"], b["4000"], b["2200"]], [100000, 100000, 0]);
    const p = await org.bookkeeper.mutation(api.payments.receive, { customerId: customer, date: "2026-03-10", amountMinor: 100000, accountId: org.acct["1010"]!, applyTo: [{ documentId: id, amountMinor: 100000 }] });
    assert.equal((await org.reviewer.query(api.invoices.get, { id }))!.derivedStatus, "paid");
    await rejectsWith(org.bookkeeper.mutation(api.payments.voidPayment, { id: p.id, date: "2026-03-11", reason: "bounced" }), "FORBIDDEN");
    await org.accountant.mutation(api.payments.voidPayment, { id: p.id, date: "2026-03-11", reason: "Cheque bounced" });
    assert.equal((await org.reviewer.query(api.invoices.get, { id }))!.balanceMinor, 100000);
    b = await balances(org);
    assert.deepEqual([b["1100"], b["1010"]], [100000, 0]);
    const payments = await org.reviewer.query(api.payments.list, {});
    assert.equal(payments[0]!.voidReason, "Cheque bounced", "the voided payment is kept with its reason");
    await assertIntegrity(org);
  }));

test("void: an unpaid invoice is voided by an exact reversal; drafts are deleted, not voided", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const { id } = await customerAndInvoice(org);
    await org.bookkeeper.mutation(api.invoices.issue, { id });
    await rejectsWith(org.bookkeeper.mutation(api.invoices.voidInvoice, { id, date: "2026-03-03", reason: "wrong customer" }), "FORBIDDEN");
    await org.accountant.mutation(api.invoices.voidInvoice, { id, date: "2026-03-03", reason: "Wrong customer" });
    const inv = await org.reviewer.query(api.invoices.get, { id });
    assert.equal(inv!.invoice.status, "void");
    assert.equal(inv!.invoice.number, "INV-0001", "the number stays used");
    assert.ok(Object.values(await balances(org)).every((x) => x === 0));
    const { id: second } = await customerAndInvoice(org).catch(async () => ({ id: await org.bookkeeper.mutation(api.invoices.create, { customerId: inv!.invoice.customerId, issueDate: "2026-03-04", lines: [{ description: "Retainer", quantityMilli: 1000, unitPriceMinor: 1000, accountId: org.acct["4000"]! }] }) }));
    assert.equal((await org.bookkeeper.mutation(api.invoices.issue, { id: second })).number, "INV-0002");
    await assertIntegrity(org);
  }));

test("bills: capture notifies approvers; only approvers approve; posting books AP; payments settle it; duplicates refused", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const vendor = await org.bookkeeper.mutation(api.contacts.create, { kind: "vendor", name: "Office Depot", defaultAccountId: org.acct["6300"]!, paymentTermsDays: 30 });
    const bill = await org.bookkeeper.mutation(api.bills.create, { vendorId: vendor, billNumber: "OD-778", billDate: "2026-04-02", lines: [{ description: "Paper", accountId: org.acct["6300"]!, amountMinor: 12000 }, { description: "Annual software", accountId: org.acct["1300"]!, amountMinor: 60000 }] });
    await rejectsWith(org.bookkeeper.mutation(api.bills.create, { vendorId: vendor, billNumber: "OD-778", billDate: "2026-04-02", lines: [{ description: "Paper", accountId: org.acct["6300"]!, amountMinor: 1 }] }), "CONFLICT");
    await rejectsWith(org.bookkeeper.mutation(api.bills.create, { vendorId: vendor, billNumber: "OD-779", billDate: "2026-04-02", lines: [{ description: "Wrong", accountId: org.acct["4000"]!, amountMinor: 1 }] }), "INVALID_ARGUMENT");
    const inbox = await org.accountant.query(api.inbox.list, {});
    assert.ok(inbox.some((n) => n.type === "bill.awaiting_approval" && (n.data as any)?.billId === bill), "the accountant was notified");
    await rejectsWith(org.bookkeeper.mutation(api.bills.post, { id: bill }), "FAILED_PRECONDITION", /approved/);
    await rejectsWith(org.bookkeeper.mutation(api.bills.approve, { id: bill }), "FORBIDDEN");
    await org.accountant.mutation(api.bills.approve, { id: bill, note: "Looks right" });
    await org.bookkeeper.mutation(api.bills.post, { id: bill });
    let b = await balances(org);
    assert.deepEqual([b["2000"], b["6300"], b["1300"]], [72000, 12000, 60000]);
    await org.bookkeeper.mutation(api.payments.pay, { vendorId: vendor, date: "2026-04-10", amountMinor: 20000, accountId: org.acct["2100"]!, applyTo: [{ documentId: bill, amountMinor: 20000 }] });
    let view = await org.reviewer.query(api.bills.get, { id: bill });
    assert.equal(view!.balanceMinor, 52000);
    await org.bookkeeper.mutation(api.payments.pay, { vendorId: vendor, date: "2026-04-20", amountMinor: 52000, accountId: org.acct["1010"]!, applyTo: [{ documentId: bill, amountMinor: 52000 }] });
    view = await org.reviewer.query(api.bills.get, { id: bill });
    assert.equal(view!.derivedStatus, "paid");
    b = await balances(org);
    assert.deepEqual([b["2000"], b["2100"], b["1010"]], [0, 20000, -52000]);
    assert.deepEqual(view!.history.map((h) => h.type).slice(0, 4), ["bill.captured", "bill.approved", "bill.posted", "bill.payment.applied"]);
    await assertIntegrity(org);
  }));

test("expenses: receipts are stored durably and read back intact; approval posts; approved expenses cannot change", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const id = await org.bookkeeper.mutation(api.expenses.create, { date: "2026-05-03", description: "Client lunch", amountMinor: 8650, expenseAccountId: org.acct["6200"]!, paidFromAccountId: org.acct["2100"]! });
    await rejectsWith(org.bookkeeper.mutation(api.expenses.create, { date: "2026-05-03", description: "Euro", amountMinor: 1, currency: "EUR", expenseAccountId: org.acct["6200"]!, paidFromAccountId: org.acct["2100"]! }), "INVALID_ARGUMENT", /multi-currency/);
    const content = Buffer.from("%PDF-1.4 receipt: lunch 86.50 USD\n");
    const receiptId = await org.bookkeeper.mutation(api.expenses.upload, { subjectType: "expense", subjectId: id, name: "lunch.pdf", contentType: "application/pdf", contentBase64: content.toString("base64") });
    const read = await org.reviewer.query(api.expenses.readReceipt, { receiptId });
    assert.equal(Buffer.from(read.contentBase64, "base64").toString(), content.toString());
    assert.equal(read.size, content.length);
    await rejectsWith(org.reviewer.mutation(api.expenses.upload, { subjectType: "expense", subjectId: id, name: "x.txt", contentBase64: "eA==" }), "FORBIDDEN");
    await rejectsWith(org.bookkeeper.mutation(api.expenses.approve, { id }), "FORBIDDEN");
    await org.accountant.mutation(api.expenses.approve, { id });
    const b = await balances(org);
    assert.deepEqual([b["6200"], b["2100"]], [8650, 8650]);
    await rejectsWith(org.bookkeeper.mutation(api.expenses.update, { id, date: "2026-05-03", description: "Client lunch", amountMinor: 1, expenseAccountId: org.acct["6200"]!, paidFromAccountId: org.acct["2100"]! }), "FAILED_PRECONDITION");
    const view = await org.reviewer.query(api.expenses.get, { id });
    assert.equal(view!.receipts.length, 1);
    assert.deepEqual(view!.history.map((h) => h.type), ["expense.recorded", "expense.receipt.attached", "expense.approved"]);
    await t.restart();
    const again = await org.reviewer.query(api.expenses.readReceipt, { receiptId });
    assert.equal(again.contentBase64, read.contentBase64, "receipt survives a restart");
    const rejected = await org.bookkeeper.mutation(api.expenses.create, { date: "2026-05-04", description: "Personal", amountMinor: 999, expenseAccountId: org.acct["6900"]!, paidFromAccountId: org.acct["2100"]! });
    await org.accountant.mutation(api.expenses.reject, { id: rejected, note: "Personal expense" });
    assert.equal((await balances(org))["6900"], 0);
    await assertIntegrity(org);
  }));

test("tenant isolation: another organization cannot see, change, pay, or read receipts of this one's records", () =>
  withApp(async (t) => {
    const a = await newOrg(t, "Boundry LLC");
    const b = await newOrg(t, "Other Co", { owner: "olga", admin: "otto", accountant: "omar", bookkeeper: "oona", reviewer: "orin" });
    const { customer, id } = await customerAndInvoice(a);
    await a.bookkeeper.mutation(api.invoices.issue, { id });
    const expense = await a.bookkeeper.mutation(api.expenses.create, { date: "2026-05-03", description: "Lunch", amountMinor: 100, expenseAccountId: a.acct["6200"]!, paidFromAccountId: a.acct["2100"]! });
    const receipt = await a.bookkeeper.mutation(api.expenses.upload, { subjectType: "expense", subjectId: expense, name: "r.txt", contentBase64: Buffer.from("secret").toString("base64") });
    const fileId = (await a.reviewer.query(api.expenses.listReceipts, { subjectId: expense }))[0]!.fileId;

    assert.equal(await b.owner.query(api.invoices.get, { id }), null);
    assert.equal((await b.owner.query(api.invoices.list, {})).length, 0);
    assert.equal((await b.owner.query(api.journal.list, {})).length, 0);
    assert.equal(await b.owner.query(api.expenses.get, { id: expense }), null);
    await rejectsWith(b.owner.query(api.expenses.readReceipt, { receiptId: receipt }), "NOT_FOUND");
    await rejectsWith(b.owner.query(api.expenses.receiptLink, { receiptId: receipt }), "NOT_FOUND");
    await rejectsWith(b.bookkeeper.mutation(api.expenses.attach, { fileId }), "NOT_FOUND");
    await rejectsWith(b.owner.mutation(api.invoices.issue, { id }), "NOT_FOUND");
    await rejectsWith(b.owner.mutation(api.invoices.voidInvoice, { id, date: "2026-03-05", reason: "attack" }), "NOT_FOUND");
    await rejectsWith(b.owner.mutation(api.payments.receive, { customerId: customer, date: "2026-03-05", amountMinor: 1, accountId: b.acct["1010"]!, applyTo: [{ documentId: id, amountMinor: 1 }] }), "INVALID_ARGUMENT");
    await rejectsWith(b.owner.mutation(api.journal.createAndPost, { date: "2026-03-05", description: "x", lines: [{ accountId: a.acct["1010"]!, debit: 1, credit: 0 }, { accountId: b.acct["1010"]!, debit: 0, credit: 1 }] }), "INVALID_ARGUMENT", /Unknown account/);
    await rejectsWith(b.accountant.mutation(api.journal.reverse, { id: (await a.reviewer.query(api.journal.list, {}))[0]!.id, date: "2026-03-05", reason: "attack" }), "NOT_FOUND");
    // A member of A who is not a member of B gets nothing in B by naming it.
    const intruder = t.as({ id: "ada", type: "user", roles: ["person"] }, { tenant: b.id });
    await rejectsWith(intruder.query(api.invoices.list, {}), "FORBIDDEN");
    // A's books are untouched.
    assert.equal((await a.reviewer.query(api.invoices.get, { id }))!.balanceMinor, 105400);
    await assertIntegrity(a);
    await assertIntegrity(b);
  }));
