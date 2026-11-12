/**
 * M2 — banking: CSV parsing, import with duplicate detection, matching, categorizing with splits,
 * excluding, and reconciliation sessions with discrepancy reporting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../feltkit/_generated/api.js";
import { normalizePayee, parseAmount, parseDate, parseStatement, splitCsv } from "../feltkit/_csv.js";
import { assertIntegrity, newOrg, rejectsWith, withApp, type Org } from "./_helpers.js";

test("CSV parsing: exact amounts, date formats, quoted fields, debit/credit layout, rejected rows reported", () => {
  assert.equal(parseAmount("1,234.56"), 123456);
  assert.equal(parseAmount("-0.07"), -7);
  assert.equal(parseAmount("(12.5)"), -1250);
  assert.equal(parseAmount("$3"), 300);
  assert.equal(parseAmount("0.1"), 10);
  assert.equal(parseAmount("12.345"), null, "no silent rounding of sub-cent amounts");
  assert.equal(parseAmount("abc"), null);
  assert.equal(parseDate("2026-01-31"), "2026-01-31");
  assert.equal(parseDate("01/31/2026"), "2026-01-31");
  assert.equal(parseDate("31/01/2026", "dmy"), "2026-01-31");
  assert.equal(parseDate("02/30/2026"), null);
  assert.deepEqual(splitCsv('a,"b, c","d ""q"""\r\n1,2,3\n'), [["a", "b, c", 'd "q"'], ["1", "2", "3"]]);
  const r = parseStatement('Date,Description,Withdrawal,Deposit,Balance\n01/02/2026,"ACME, INC PAYMENT",,"1,500.00",2500.00\n01/03/2026,Coffee,4.50,,2495.50\nnot a date,Bad,1,,\n01/04/2026,Zero,,,\n');
  assert.deepEqual(r.rows.map((x) => [x.date, x.amountMinor, x.balanceMinor]), [["2026-01-02", 150000, 250000], ["2026-01-03", -450, 249550]]);
  assert.deepEqual(r.rejected.map((x) => x.row), [4, 5]);
  assert.throws(() => parseStatement("When,What\n1,2\n"), /needs Date, Description/);
  assert.equal(normalizePayee("POS PURCHASE 4411 STARBUCKS #1234 SEATTLE"), "starbucks seattle");
});

const JAN = [
  "Date,Description,Amount",
  "2026-01-03,Deposit Northwind INV-0001,1054.00",
  "2026-01-05,STARBUCKS #1234,-4.50",
  "2026-01-05,STARBUCKS #1234,-4.50", // the same coffee twice in one day: two real transactions
  "2026-01-09,GITHUB INC,-120.00",
  "2026-01-15,Office Depot,-86.50",
  "2026-01-20,Monthly service fee,-15.00",
  "2026-01-22,garbage row,not money",
].join("\n");

async function setupBank(org: Org) {
  const bankAccountId = await org.accountant.mutation(api.banking.createAccount, { name: "Chase Checking", accountId: org.acct["1010"]!, institution: "Chase", last4: "4321" });
  await org.accountant.mutation(api.accounts.setOpeningBalances, { date: "2025-12-31", balances: [{ accountId: org.acct["1010"]!, balanceMinor: 100000 }] });
  return bankAccountId;
}

test("import: identical rows in one statement are kept; re-importing a file is idempotent; overlapping statements report duplicates", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const bankAccountId = await setupBank(org);
    await rejectsWith(org.reviewer.mutation(api.banking.importStatement, { bankAccountId, fileName: "jan.csv", csv: JAN }), "FORBIDDEN");
    const first = await org.bookkeeper.mutation(api.banking.importStatement, { bankAccountId, fileName: "jan.csv", csv: JAN });
    assert.deepEqual([first.imported, first.duplicates, first.rejected, first.replayed], [6, 0, 1, false]);
    const again = await org.bookkeeper.mutation(api.banking.importStatement, { bankAccountId, fileName: "jan-again.csv", csv: JAN });
    assert.deepEqual([again.importId, again.replayed], [first.importId, true]);
    const overlap = ["Date,Description,Amount", "2026-01-20,Monthly service fee,-15.00", "2026-01-05,STARBUCKS #1234,-4.50", "2026-01-28,Stripe payout,250.00"].join("\n");
    const second = await org.bookkeeper.mutation(api.banking.importStatement, { bankAccountId, fileName: "late-jan.csv", csv: overlap });
    assert.deepEqual([second.imported, second.duplicates], [1, 2]);
    const [latest] = await org.reviewer.query(api.banking.imports, { bankAccountId });
    assert.equal(latest!.duplicates.length, 2, "each duplicate is recorded with the transaction it duplicates");
    assert.ok(latest!.duplicates.every((d) => d.existingId));
    const firstImport = (await org.reviewer.query(api.banking.imports, { bankAccountId })).find((i) => i.id === first.importId)!;
    assert.equal(firstImport.rejected[0]!.reason, "Unreadable amount");
    const txns = await org.reviewer.query(api.banking.transactions, { bankAccountId });
    assert.equal(txns.length, 7);
    assert.equal(txns.filter((x) => x.description.startsWith("STARBUCKS")).length, 2);
    assert.ok(txns.every((x) => x.status === "unmatched"));
  }));

test("matching, categorizing with splits, excluding; reconciliation reports discrepancies, completes, and locks its evidence", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const bankAccountId = await setupBank(org);
    // Business activity recorded in the books first: an invoice paid into the bank, an expense paid from it.
    const customer = await org.bookkeeper.mutation(api.contacts.create, { kind: "customer", name: "Northwind" });
    const inv = await org.bookkeeper.mutation(api.invoices.create, { customerId: customer, issueDate: "2026-01-01", lines: [{ description: "Retainer", quantityMilli: 1000, unitPriceMinor: 105400, accountId: org.acct["4000"]! }] });
    await org.bookkeeper.mutation(api.invoices.issue, { id: inv });
    await org.bookkeeper.mutation(api.payments.receive, { customerId: customer, date: "2026-01-02", amountMinor: 105400, accountId: org.acct["1010"]!, applyTo: [{ documentId: inv, amountMinor: 105400 }] });
    const expense = await org.bookkeeper.mutation(api.expenses.create, { date: "2026-01-15", description: "Printer paper", amountMinor: 8650, expenseAccountId: org.acct["6300"]!, paidFromAccountId: org.acct["1010"]! });
    await org.accountant.mutation(api.expenses.approve, { id: expense });
    // A cheque written in the books that has not cleared the bank yet (outstanding).
    await org.accountant.mutation(api.journal.createAndPost, { date: "2026-01-29", description: "Cheque 101 to landlord", lines: [{ accountId: org.acct["6500"]!, debit: 50000, credit: 0 }, { accountId: org.acct["1010"]!, debit: 0, credit: 50000 }] });

    await org.bookkeeper.mutation(api.banking.importStatement, { bankAccountId, fileName: "jan.csv", csv: JAN });
    const txns = await org.reviewer.query(api.banking.transactions, { bankAccountId });
    const by = (prefix: string) => txns.filter((x) => x.description.startsWith(prefix));

    // Statement: opening 1000.00; transactions sum 1054 − 4.5 − 4.5 − 120 − 86.5 − 15 = 823.50 → closing 1823.50.
    const recId = await org.bookkeeper.mutation(api.reconciliation.start, { bankAccountId, statementStart: "2026-01-01", statementEnd: "2026-01-31", openingBalanceMinor: 100000, closingBalanceMinor: 182350 });
    let w = await org.reviewer.query(api.reconciliation.get, { id: recId });
    assert.equal(w.statementDifferenceMinor, 0);
    assert.equal(w.unmatched.length, 6);
    assert.equal(w.canComplete, false);
    await rejectsWith(org.accountant.mutation(api.reconciliation.complete, { id: recId }), "FAILED_PRECONDITION", /not in the books/);

    // Deposit ↔ the recorded customer payment.
    const deposit = by("Deposit")[0]!;
    const cands = await org.reviewer.query(api.banking.candidates, { bankTransactionId: deposit.id });
    assert.equal(cands.length, 1);
    assert.equal(cands[0]!.sourceType, "payment_received");
    await rejectsWith(org.reviewer.mutation(api.banking.match, { bankTransactionId: deposit.id, ledgerLineIds: [cands[0]!.lineId] }), "FORBIDDEN");
    await org.bookkeeper.mutation(api.banking.match, { bankTransactionId: deposit.id, ledgerLineIds: [cands[0]!.lineId] });
    // The same line cannot clear a second transaction.
    await rejectsWith(org.bookkeeper.mutation(api.banking.match, { bankTransactionId: by("Office Depot")[0]!.id, ledgerLineIds: [cands[0]!.lineId] }), "CONFLICT");
    // Office Depot ↔ the approved expense; the expense now points at its bank evidence.
    const od = by("Office Depot")[0]!;
    const odCand = await org.reviewer.query(api.banking.candidates, { bankTransactionId: od.id });
    await org.bookkeeper.mutation(api.banking.match, { bankTransactionId: od.id, ledgerLineIds: [odCand[0]!.lineId] });
    assert.equal((await org.reviewer.query(api.expenses.get, { id: expense }))!.expense.bankTransactionId, od.id);
    // GitHub split: 100 software + 20 sales tax treated as expense (misc).
    const gh = by("GITHUB")[0]!;
    await rejectsWith(org.bookkeeper.mutation(api.banking.categorize, { bankTransactionId: gh.id, splits: [{ accountId: org.acct["6600"]!, amountMinor: 10000 }] }), "INVALID_ARGUMENT", /splits total/);
    const ghEntry = await org.bookkeeper.mutation(api.banking.categorize, { bankTransactionId: gh.id, splits: [{ accountId: org.acct["6600"]!, amountMinor: 10000, memo: "Team plan" }, { accountId: org.acct["6900"]!, amountMinor: 2000, memo: "Tax" }] });
    const ghView = await org.reviewer.query(api.journal.get, { id: ghEntry.journalEntryId });
    assert.equal(ghView!.lines.length, 3);
    // Coffees and the fee: categorize; one coffee was a duplicate charge the bank later refunded → exclude it, with a reason.
    const [c1, c2] = by("STARBUCKS");
    await org.bookkeeper.mutation(api.banking.categorize, { bankTransactionId: c1!.id, splits: [{ accountId: org.acct["6200"]!, amountMinor: 450 }] });
    await org.bookkeeper.mutation(api.banking.categorize, { bankTransactionId: by("Monthly")[0]!.id, splits: [{ accountId: org.acct["6100"]!, amountMinor: 1500 }] });
    await org.bookkeeper.mutation(api.banking.exclude, { bankTransactionId: c2!.id, reason: "Personal card swipe; owner repaid" });

    w = await org.reviewer.query(api.reconciliation.get, { id: recId });
    // Excluding the coffee leaves the statement off by 4.50: the workspace says so instead of hiding it.
    assert.equal(w.statementDifferenceMinor, -450);
    assert.ok(w.discrepancies.some((d) => /do not add up/.test(d)));
    assert.equal(w.excluded.length, 1);
    await org.bookkeeper.mutation(api.banking.include, { bankTransactionId: c2!.id });
    await org.bookkeeper.mutation(api.banking.categorize, { bankTransactionId: c2!.id, splits: [{ accountId: org.acct["3100"]!, amountMinor: 450, memo: "Owner draw" }] });

    w = await org.reviewer.query(api.reconciliation.get, { id: recId });
    assert.deepEqual([w.unmatched.length, w.statementDifferenceMinor, w.differenceMinor], [0, 0, 0]);
    assert.equal(w.outstanding.length, 1, "the uncleared cheque is an outstanding item");
    assert.equal(w.outstanding[0]!.amountMinor, -50000);
    assert.equal(w.bookBalanceMinor - w.outstandingMinor, w.clearedMinor, "book − outstanding = cleared");
    assert.equal(w.canComplete, true);
    await rejectsWith(org.bookkeeper.mutation(api.reconciliation.complete, { id: recId }), "FORBIDDEN");
    await org.accountant.mutation(api.reconciliation.complete, { id: recId });
    const done = await org.reviewer.query(api.reconciliation.get, { id: recId });
    assert.equal(done.reconciliation.status, "completed");
    assert.equal(done.reconciliation.result!.bankTransactionIds.length, 6);
    await rejectsWith(org.bookkeeper.mutation(api.banking.unmatch, { bankTransactionId: gh.id, reason: "change mind" }), "FAILED_PRECONDITION", /reconciliation/);
    await rejectsWith(org.accountant.mutation(api.reconciliation.complete, { id: recId }), "FAILED_PRECONDITION");

    // The next statement opens at the reconciled closing balance.
    await rejectsWith(org.bookkeeper.mutation(api.reconciliation.start, { bankAccountId, statementEnd: "2026-02-28", closingBalanceMinor: 1, openingBalanceMinor: 5 }), "FAILED_PRECONDITION", /differs/);
    const feb = await org.bookkeeper.mutation(api.reconciliation.start, { bankAccountId, statementEnd: "2026-02-28", closingBalanceMinor: 132350 });
    const fw = await org.reviewer.query(api.reconciliation.get, { id: feb });
    assert.equal(fw.reconciliation.statementStart, "2026-02-01");
    assert.equal(fw.reconciliation.openingBalanceMinor, 182350);
    await assertIntegrity(org);
  }));

test("unmatching a categorized transaction reverses its entry; nothing is deleted from the ledger", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const bankAccountId = await setupBank(org);
    await org.bookkeeper.mutation(api.banking.importStatement, { bankAccountId, fileName: "jan.csv", csv: JAN });
    const fee = (await org.reviewer.query(api.banking.transactions, { bankAccountId })).find((x) => x.description.startsWith("Monthly"))!;
    const cat = await org.bookkeeper.mutation(api.banking.categorize, { bankTransactionId: fee.id, splits: [{ accountId: org.acct["6900"]!, amountMinor: 1500 }] });
    const before = (await org.reviewer.query(api.journal.list, { status: "posted" })).length;
    const r = await org.bookkeeper.mutation(api.banking.unmatch, { bankTransactionId: fee.id, reason: "Wrong account" });
    assert.ok(r.reversalEntryId);
    const after = await org.reviewer.query(api.journal.list, { status: "posted" });
    assert.equal(after.length, before + 1);
    assert.ok(after.find((e) => e.id === cat.journalEntryId)!.reversed);
    const txn = (await org.reviewer.query(api.banking.transactions, { bankAccountId })).find((x) => x.id === fee.id)!;
    assert.equal(txn.status, "unmatched");
    assert.equal(txn.journalEntryId, undefined, "the stale entry link is removed");
    // The reversed entry's bank line is not offered as a match candidate.
    assert.equal((await org.reviewer.query(api.banking.candidates, { bankTransactionId: fee.id })).length, 0);
    await org.bookkeeper.mutation(api.banking.categorize, { bankTransactionId: fee.id, splits: [{ accountId: org.acct["6100"]!, amountMinor: 1500 }] });
    const b = Object.fromEntries((await org.reviewer.query(api.accounts.list, {})).map((a) => [a.number, a.balanceMinor]));
    assert.deepEqual([b["6900"], b["6100"]], [0, 1500]);
    await assertIntegrity(org);
  }));
