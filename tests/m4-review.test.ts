/**
 * M4 — agentic bookkeeping under explicit authority: agents read and propose; people approve; approval
 * executes through the same code paths; every step leaves evidence. No AI service is configured in
 * these tests (or anywhere in Ledger's defaults): the rules are deterministic code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../feltkit/_generated/api.js";
import { assertIntegrity, newOrg, rejectsWith, withApp, type Org } from "./_helpers.js";

const CSV = [
  "Date,Description,Amount",
  "2026-02-02,GITHUB INC 8812,-21.00",
  "2026-03-02,GITHUB INC 9932,-21.00",
  "2026-03-05,Deposit Acme,500.00",
  "2026-03-06,BLUE BOTTLE COFFEE,-6.00",
  "2026-03-06,BLUE BOTTLE COFFEE,-6.00",
  "2026-03-09,STAPLES STORE 22,-48.10",
].join("\n");

async function setup(org: Org) {
  const bankAccountId = await org.accountant.mutation(api.banking.createAccount, { name: "Checking", accountId: org.acct["1010"]! });
  await org.bookkeeper.mutation(api.banking.importStatement, { bankAccountId, fileName: "q1.csv", csv: CSV });
  const txns = await org.reviewer.query(api.banking.transactions, { bankAccountId });
  const by = (p: string) => txns.filter((t) => t.description.startsWith(p)).sort((x, y) => (x.date < y.date ? -1 : 1));
  return { bankAccountId, by };
}

test("an agent reads and proposes, but cannot execute any financial action, even if given a role that could", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const { by } = await setup(org);
    const gh = by("GITHUB")[0]!;
    // Reads through capabilities work.
    assert.ok((await org.agent.query(api.reports.trialBalance, {})).balanced);
    assert.ok(Array.isArray(await org.agent.query(api.review.queue, { asOf: "2026-03-31" })));
    // Every executing function is refused.
    await rejectsWith(org.agent.mutation(api.banking.categorize, { bankTransactionId: gh.id, splits: [{ accountId: org.acct["6600"]!, amountMinor: 2100 }] }), "FORBIDDEN");
    await rejectsWith(org.agent.mutation(api.journal.createAndPost, { date: "2026-03-01", description: "x", lines: [{ accountId: org.acct["6900"]!, debit: 1, credit: 0 }, { accountId: org.acct["1010"]!, debit: 0, credit: 1 }] }), "FORBIDDEN");
    await rejectsWith(org.agent.mutation(api.org.closePeriod, { through: "2026-01-31" }), "FORBIDDEN");
    await rejectsWith(org.agent.mutation(api.expenses.create, { date: "2026-03-01", description: "x", amountMinor: 1, expenseAccountId: org.acct["6900"]!, paidFromAccountId: org.acct["1010"]! }), "FORBIDDEN");
    // Receipts: the agent can see that an expense has one, but not read its bytes (no files.read).
    const exp = await org.bookkeeper.mutation(api.expenses.create, { date: "2026-03-01", description: "Lunch", amountMinor: 100, expenseAccountId: org.acct["6200"]!, paidFromAccountId: org.acct["2100"]! });
    const receiptId = await org.bookkeeper.mutation(api.expenses.upload, { subjectType: "expense", subjectId: exp, name: "r.txt", contentBase64: Buffer.from("private").toString("base64") });
    assert.equal((await org.agent.query(api.expenses.get, { id: exp }))!.receipts.length, 1);
    await rejectsWith(org.agent.query(api.expenses.readReceipt, { receiptId }), "FORBIDDEN");
    // It can propose.
    const p = await org.agent.mutation(api.review.propose, { action: "bank.categorize", input: { bankTransactionId: gh.id, splits: [{ accountId: org.acct["6600"]!, amountMinor: 2100 }] }, summary: "GitHub is a software subscription", rationale: "Recurring monthly charge from GitHub." });
    assert.equal(p.created, true);
    await rejectsWith(org.agent.mutation(api.review.approve, { id: p.id }), "FORBIDDEN");

    // Misconfiguration: an agent added with the bookkeeper role. Ledger still refuses to let a
    // non-person run a financial mutation directly.
    const ownerCtx = (await t.tenancy!.context(org.id, "ada"))!;
    await t.tenancy!.addPrincipal({ ...ownerCtx, principalId: "ada" }, { id: "rogue-bot", type: "agent" }, "bookkeeper");
    const rogue = t.as({ id: "rogue-bot", type: "agent", roles: [] }, { tenant: org.id });
    assert.ok((await rogue.query(api.org.me, {})).permissions.includes("banking.categorize"), "the role grants it");
    await rejectsWith(rogue.mutation(api.banking.categorize, { bankTransactionId: gh.id, splits: [{ accountId: org.acct["6600"]!, amountMinor: 2100 }] }), "FORBIDDEN");
    await rejectsWith(rogue.mutation(api.invoices.issue, { id: "anything" }), "FORBIDDEN");
    await rejectsWith(rogue.mutation(api.review.approve, { id: p.id }), "FORBIDDEN");
    // Refused by Ledger's own person-only rule (portable to AppBoundry, where FeltKit's approval flag is
    // not enforced), and the refusal is in FeltKit's activity log as evidence.
    const refused = (await t.runtime.activity.list({ name: "banking:categorize" })).find((e) => e.principal?.id === "rogue-bot");
    assert.ok(refused);
    assert.notEqual(refused!.outcome, "success");
    assert.equal(refused!.error!.code, "FORBIDDEN");
    assert.match(refused!.error!.message, /taken by people/);
    assert.equal((await org.reviewer.query(api.banking.transactions, { bankAccountId: gh.bankAccountId })).find((x) => x.id === gh.id)!.status, "unmatched", "nothing executed");
    assert.equal((await org.reviewer.query(api.journal.list, {})).length, 0);
  }));

test("a person approves an agent's proposal: it executes in their transaction, with full evidence", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const { by } = await setup(org);
    const gh = by("GITHUB")[0]!;
    const p = await org.agent.mutation(api.review.propose, { action: "bank.categorize", input: { bankTransactionId: gh.id, splits: [{ accountId: org.acct["6600"]!, amountMinor: 2100 }] }, summary: "GitHub → Software", rationale: "Recurring developer tooling.", evidence: { seen: gh.id } });
    const dup = await org.agent.mutation(api.review.propose, { action: "bank.categorize", input: { bankTransactionId: gh.id, splits: [{ accountId: org.acct["6900"]!, amountMinor: 2100 }] }, summary: "again", rationale: "again" });
    assert.deepEqual([dup.id, dup.created], [p.id, false], "one open proposal per transaction");
    await rejectsWith(org.reviewer.mutation(api.review.approve, { id: p.id }), "FORBIDDEN");
    const r = await org.bookkeeper.mutation(api.review.approve, { id: p.id, reason: "Agreed" });
    const entryId = String(r.result.journalEntryId);
    const je = await org.reviewer.query(api.journal.get, { id: entryId });
    assert.equal(je!.entry.proposalId, p.id);
    assert.equal(je!.entry.approvedBy, "grace");
    const [stored] = await org.reviewer.query(api.review.list, { status: "approved" });
    assert.deepEqual([stored!.proposedByType, stored!.decidedBy, stored!.decisionReason, (stored!.evidence as any).seen], ["agent", "grace", "Agreed", gh.id]);
    const trail = await org.reviewer.query(api.activity.list, { subjectType: "proposal", subjectId: p.id });
    assert.deepEqual(trail.map((e) => [e.type, e.actorType]).reverse(), [["proposal.created", "agent"], ["proposal.approved", "user"]]);
    assert.equal((trail.find((e) => e.type === "proposal.created")!.data as any).agent, true);
    await rejectsWith(org.bookkeeper.mutation(api.review.approve, { id: p.id }), "FAILED_PRECONDITION");
    await assertIntegrity(org);
  }));

test("separation of duties: no one approves their own proposal; the approver needs the action's own permission", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const input = { date: "2026-03-31", description: "Accrue March interest", lines: [{ accountId: org.acct["6900"]!, debit: 1250, credit: 0 }, { accountId: org.acct["2500"]!, debit: 0, credit: 1250 }] };
    const mine = await org.bookkeeper.mutation(api.review.propose, { action: "journal.post", input, summary: "Interest accrual", rationale: "Loan statement shows 12.50 interest." });
    await rejectsWith(org.bookkeeper.mutation(api.review.approve, { id: mine.id }), "FORBIDDEN", /other than its proposer/);
    const agents = await org.agent.mutation(api.review.propose, { action: "journal.post", input: { ...input, description: "Accrue April interest", date: "2026-04-30" }, summary: "Interest", rationale: "Same as March." });
    await rejectsWith(org.bookkeeper.mutation(api.review.approve, { id: agents.id }), "FORBIDDEN", /journal.post/);
    await rejectsWith(org.agent.mutation(api.review.propose, { action: "journal.post", input: { ...input, lines: [{ accountId: org.acct["1100"]!, debit: 5, credit: 0 }, { accountId: org.acct["4000"]!, debit: 0, credit: 5 }] }, summary: "xyz", rationale: "xyz" }), "FAILED_PRECONDITION", /control account/);
    await rejectsWith(org.agent.mutation(api.review.propose, { action: "journal.post", input: { ...input, lines: [{ accountId: org.acct["6900"]!, debit: 5, credit: 0 }, { accountId: org.acct["2500"]!, debit: 0, credit: 4 }] }, summary: "xyz", rationale: "xyz" }), "INVALID_ARGUMENT", /does not balance/);
    const done = await org.accountant.mutation(api.review.approve, { id: mine.id });
    assert.equal((await org.reviewer.query(api.journal.get, { id: String(done.result.journalEntryId) }))!.entry.sourceType, "proposal");
    await org.accountant.mutation(api.review.reject, { id: agents.id, reason: "April not closed yet" });
    assert.equal((await org.reviewer.query(api.review.list, { status: "rejected" }))[0]!.decisionReason, "April not closed yet");
    await assertIntegrity(org);
  }));

test("rules: match recorded payments, repeat past categorizations, use vendor defaults; never twice; stale proposals change nothing", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const { by } = await setup(org);
    // Books: a payment from Acme deposited on 03-04 (the bank shows it 03-05).
    const acme = await org.bookkeeper.mutation(api.contacts.create, { kind: "customer", name: "Acme" });
    const inv = await org.bookkeeper.mutation(api.invoices.create, { customerId: acme, issueDate: "2026-03-01", lines: [{ description: "Work", quantityMilli: 1000, unitPriceMinor: 50000, accountId: org.acct["4000"]! }] });
    await org.bookkeeper.mutation(api.invoices.issue, { id: inv });
    await org.bookkeeper.mutation(api.payments.receive, { customerId: acme, date: "2026-03-04", amountMinor: 50000, accountId: org.acct["1010"]!, applyTo: [{ documentId: inv, amountMinor: 50000 }] });
    // History: February's GitHub charge was categorized to Software by a person.
    await org.bookkeeper.mutation(api.banking.categorize, { bankTransactionId: by("GITHUB")[0]!.id, splits: [{ accountId: org.acct["6600"]!, amountMinor: 2100 }] });
    // A vendor with a default account.
    await org.bookkeeper.mutation(api.contacts.create, { kind: "vendor", name: "Staples", defaultAccountId: org.acct["6300"]! });

    const first = await org.agent.mutation(api.review.scan, {});
    assert.equal(first.proposed, 3);
    const pending = await org.reviewer.query(api.review.list, { status: "pending" });
    const bySource = Object.fromEntries(pending.map((p) => [p.source, p]));
    assert.deepEqual(Object.keys(bySource).sort(), ["rules:history", "rules:match", "rules:vendor"]);
    assert.equal((bySource["rules:history"]!.input as any).bankTransactionId, by("GITHUB")[1]!.id);
    assert.match(bySource["rules:history"]!.rationale, /categorized to 6600 Software/);
    assert.equal((bySource["rules:vendor"]!.input as any).splits[0].accountId, org.acct["6300"]);
    assert.equal((await org.agent.mutation(api.review.scan, {})).proposed, 0, "re-running proposes nothing new");
    assert.equal(bySource["rules:match"]!.proposedBy, "ledger-rules");
    assert.equal((bySource["rules:match"]!.evidence as any).triggeredByType, "agent", "who ran the rules is kept as evidence");

    // Someone categorizes the Staples charge by hand before the proposal is decided: approving the stale
    // proposal fails as a whole and writes nothing; it stays pending until someone rejects it.
    const staples = by("STAPLES")[0]!;
    await org.bookkeeper.mutation(api.banking.categorize, { bankTransactionId: staples.id, splits: [{ accountId: org.acct["6900"]!, amountMinor: 4810 }] });
    const entriesBefore = (await org.reviewer.query(api.journal.list, {})).length;
    await rejectsWith(org.bookkeeper.mutation(api.review.approve, { id: bySource["rules:vendor"]!.id }), "FAILED_PRECONDITION");
    assert.equal((await org.reviewer.query(api.journal.list, {})).length, entriesBefore);
    assert.equal((await org.reviewer.query(api.review.list, { status: "pending" })).length, 2, "the hand-categorized transaction's proposal is no longer pending");
    const superseded = (await org.reviewer.query(api.review.list, { status: "superseded" }))[0]!;
    assert.deepEqual([superseded.id, superseded.decidedBy], [bySource["rules:vendor"]!.id, "grace"]);
    // A person who runs the rules can approve what the rules propose (they are Ledger's proposals, not theirs).
    await org.bookkeeper.mutation(api.review.scan, {});

    await org.bookkeeper.mutation(api.review.approve, { id: bySource["rules:match"]!.id });
    await org.bookkeeper.mutation(api.review.approve, { id: bySource["rules:history"]!.id });
    const deposit = (await org.reviewer.query(api.banking.transactions, { bankAccountId: staples.bankAccountId })).find((x) => x.description.startsWith("Deposit"))!;
    assert.equal(deposit.status, "matched");
    await assertIntegrity(org);
  }));

test("after an import, the rules run as a background job in that organization, as the importer; refused once they are removed", () =>
  withApp(async (t) => {
    // Platform behaviour this relies on (FeltKit G-01): a job carries its organization and the
    // importer's live membership. Before it, the scan had to run synchronously from the browser.
    const a = await newOrg(t, "Acme");
    const b = await newOrg(t, "Globex", { owner: "gus", admin: "gia", accountant: "gil", bookkeeper: "gwen", reviewer: "gabe" });
    // A vendor default in each organization, so the rules have something to propose for STAPLES.
    for (const org of [a, b]) await org.bookkeeper.mutation(api.contacts.create, { kind: "vendor", name: "Staples", defaultAccountId: org.acct["6300"]! });
    await setup(a);
    const bBank = await b.accountant.mutation(api.banking.createAccount, { name: "Checking", accountId: b.acct["1010"]! });
    assert.equal((await a.reviewer.query(api.review.list, { status: "pending" })).length, 0, "nothing proposed during the import itself");
    const tick = await t.runtime.runServices();
    assert.deepEqual([tick.jobs, tick.failed.jobs], [1, 0]);
    const proposedA = await a.reviewer.query(api.review.list, { status: "pending" });
    assert.deepEqual(proposedA.map((p) => p.source), ["rules:vendor"], "the job proposed in Acme");
    const run = (await t.runtime.activity.list({ name: "review:scanJob" })).find((e) => e.outcome === "success");
    assert.equal(run?.principal?.id, "grace", "run as the importer");
    assert.equal((await b.reviewer.query(api.review.list, { status: "pending" })).length, 0, "and nothing in Globex");

    // Globex's bookkeeper imports, then leaves before the job runs: the job is refused, nothing proposed.
    await b.bookkeeper.mutation(api.banking.importStatement, { bankAccountId: bBank, fileName: "g.csv", csv: CSV });
    const ownerB = { ...(await t.tenancy!.context(b.id, "gus"))!, principalId: "gus" };
    await t.tenancy!.remove(ownerB, "gwen");
    const later = await t.runtime.runServices();
    assert.deepEqual([later.jobs, later.failed.jobs], [1, 1]);
    assert.equal((await b.reviewer.query(api.review.list, { status: "pending" })).length, 0);
    await assertIntegrity(a);
    await assertIntegrity(b);
  }));

test("the review queue surfaces duplicates, missing receipts, unusual amounts, approvals and overdue documents", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    await setup(org);
    const acme = await org.bookkeeper.mutation(api.contacts.create, { kind: "customer", name: "Acme", paymentTermsDays: 10 });
    const inv = await org.bookkeeper.mutation(api.invoices.create, { customerId: acme, issueDate: "2026-01-02", lines: [{ description: "Work", quantityMilli: 1000, unitPriceMinor: 90000, accountId: org.acct["4000"]! }] });
    await org.bookkeeper.mutation(api.invoices.issue, { id: inv });
    const big = await org.bookkeeper.mutation(api.expenses.create, { date: "2026-03-10", description: "Conference flights", amountMinor: 120000, expenseAccountId: org.acct["6700"]!, paidFromAccountId: org.acct["2100"]! });
    for (const [i, amt] of [3000, 2500, 4100, 3600].entries()) {
      const e = await org.bookkeeper.mutation(api.expenses.create, { date: `2026-02-0${i + 1}`, description: `Taxi ${i}`, amountMinor: amt, expenseAccountId: org.acct["6700"]!, paidFromAccountId: org.acct["2100"]! });
      await org.accountant.mutation(api.expenses.approve, { id: e });
    }
    await org.accountant.mutation(api.expenses.approve, { id: big });
    const q = await org.reviewer.query(api.review.queue, { asOf: "2026-03-31" });
    const kinds = (k: string) => q.filter((i) => i.kind === k);
    assert.ok(kinds("duplicate").some((i) => /BLUE BOTTLE/.test(i.title)), "same coffee twice on one day");
    assert.ok(kinds("receipt").some((i) => i.link.id === big), "1,200.00 of flights with no receipt");
    assert.ok(kinds("unusual").some((i) => /Travel/.test(i.title)), "flights far above the usual travel spend");
    assert.ok(kinds("overdue_invoice").some((i) => i.link.id === inv));
    assert.ok(kinds("unmatched").length === 1);
    assert.ok(kinds("reconcile").length === 1);
    assert.equal(q[0]!.severity, "high", "most severe first");
  }));
