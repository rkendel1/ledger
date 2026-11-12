/**
 * M0 — the accounting foundation: organization setup, chart of accounts, the double-entry engine,
 * drafts, posting, reversal, closed periods, idempotency, concurrency, and property-based invariants.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../feltkit/_generated/api.js";
import { assertIntegrity, cr, dl, newOrg, rejectsWith, rng, withApp } from "./_helpers.js";

test("setup creates the organization's settings and starting chart, once", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const settings = await org.reviewer.query(api.org.settings, {});
    assert.equal(settings!.baseCurrency, "USD");
    assert.equal(settings!.closedThrough, "");
    const accounts = await org.reviewer.query(api.accounts.list, {});
    assert.ok(accounts.length >= 20);
    assert.ok(accounts.every((a) => a.balanceMinor === 0));
    await rejectsWith(org.owner.mutation(api.org.setup, { legalName: "Again", baseCurrency: "USD", fiscalYearStartMonth: 1 }), "FAILED_PRECONDITION");
    await rejectsWith(org.bookkeeper.mutation(api.accounts.create, { number: "6950", name: "Dues", type: "expense", subtype: "expense" }), "FORBIDDEN");
    const id = await org.accountant.mutation(api.accounts.create, { number: "6950", name: "Dues", type: "expense", subtype: "expense" });
    assert.ok(id);
    await rejectsWith(org.accountant.mutation(api.accounts.create, { number: "6950", name: "Dup", type: "expense", subtype: "expense" }), "CONFLICT");
    await rejectsWith(org.accountant.mutation(api.accounts.create, { number: "6960", name: "Wrong", type: "expense", subtype: "bank" }), "INVALID_ARGUMENT");
    await rejectsWith(org.accountant.mutation(api.accounts.update, { id: org.acct["1100"]!, active: false }), "FAILED_PRECONDITION");
    // Control accounts: a manual journal cannot touch Accounts Receivable or Payable.
    await rejectsWith(org.accountant.mutation(api.journal.createAndPost, { date: "2026-01-02", description: "Fake receivable", lines: [{ accountId: org.acct["1100"]!, debit: 100, credit: 0 }, { accountId: org.acct["4000"]!, debit: 0, credit: 100 }] }), "FAILED_PRECONDITION", /control account/);
    await rejectsWith(org.bookkeeper.mutation(api.journal.createDraft, { date: "2026-01-02", description: "Fake payable", lines: [{ accountId: org.acct["6500"]!, debit: 100, credit: 0 }, { accountId: org.acct["2000"]!, debit: 0, credit: 100 }] }), "FAILED_PRECONDITION", /control account/);
  }));

test("posting: balanced entries post with gapless numbers; unbalanced and malformed entries are refused", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const { acct } = org;
    const a = await org.accountant.mutation(api.journal.createAndPost, { date: "2026-01-05", description: "Owner investment", lines: [dl(acct["1010"]!, 500000), cr(acct["3000"]!, 500000)] });
    const b = await org.accountant.mutation(api.journal.createAndPost, { date: "2026-01-06", description: "Laptop", lines: [dl(acct["1500"]!, 180000), cr(acct["1010"]!, 180000)] });
    assert.deepEqual([a.number, b.number], [1, 2]);
    await rejectsWith(org.accountant.mutation(api.journal.createAndPost, { date: "2026-01-06", description: "Bad", lines: [dl(acct["1500"]!, 100), cr(acct["1010"]!, 99)] }), "INVALID_ARGUMENT", /does not balance/);
    await rejectsWith(org.accountant.mutation(api.journal.createAndPost, { date: "2026-01-06", description: "One line", lines: [dl(acct["1500"]!, 100), cr(acct["1010"]!, 0)] }), "INVALID_ARGUMENT");
    await rejectsWith(org.accountant.mutation(api.journal.createAndPost, { date: "2026-01-06", description: "Both sides", lines: [{ accountId: acct["1500"]!, debit: 5, credit: 5 }, cr(acct["1010"]!, 0)] }), "INVALID_ARGUMENT");
    await rejectsWith(org.accountant.mutation(api.journal.createAndPost, { date: "2026-02-30", description: "Bad date", lines: [dl(acct["1500"]!, 1), cr(acct["1010"]!, 1)] }), "INVALID_ARGUMENT", /calendar date/);
    await rejectsWith(org.accountant.mutation(api.journal.createAndPost, { date: "2026-01-06", description: "Fraction", lines: [dl(acct["1500"]!, 1.5), cr(acct["1010"]!, 1.5)] }), "INVALID_ARGUMENT");
    await rejectsWith(org.accountant.mutation(api.journal.createAndPost, { date: "2026-01-06", description: "Unknown", lines: [dl("nope", 1), cr(acct["1010"]!, 1)] }), "INVALID_ARGUMENT");
    const balances = Object.fromEntries((await org.reviewer.query(api.accounts.list, {})).map((x) => [x.number, x.balanceMinor]));
    assert.equal(balances["1010"], 320000);
    assert.equal(balances["1500"], 180000);
    assert.equal(balances["3000"], 500000);
    const next = await org.accountant.mutation(api.journal.createAndPost, { date: "2026-01-07", description: "Next", lines: [dl(acct["6300"]!, 1000), cr(acct["1010"]!, 1000)] });
    assert.equal(next.number, 3, "refused postings consume no numbers");
    await assertIntegrity(org);
  }));

test("drafts never affect balances or reports; posted entries cannot be edited or deleted", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const { acct } = org;
    const draft = await org.bookkeeper.mutation(api.journal.createDraft, { date: "2026-03-01", description: "Accrue rent", lines: [dl(acct["6500"]!, 200000), cr(acct["2500"]!, 200000)] });
    const tb = await org.reviewer.query(api.reports.trialBalance, { asOf: "2026-12-31" });
    assert.equal(tb.totalDebitMinor, 0);
    assert.ok((await org.reviewer.query(api.accounts.list, {})).every((a) => a.balanceMinor === 0));
    await org.bookkeeper.mutation(api.journal.updateDraft, { id: draft, date: "2026-03-01", description: "Accrue March rent", lines: [dl(acct["6500"]!, 210000), cr(acct["2500"]!, 210000)] });
    await rejectsWith(org.bookkeeper.mutation(api.journal.post, { id: draft }), "FORBIDDEN");
    const posted = await org.accountant.mutation(api.journal.post, { id: draft });
    assert.equal(posted.number, 1);
    await rejectsWith(org.bookkeeper.mutation(api.journal.updateDraft, { id: draft, date: "2026-03-01", description: "x", lines: [dl(acct["6500"]!, 1), cr(acct["2000"]!, 1)] }), "FAILED_PRECONDITION", /Posted entries cannot be edited/);
    await rejectsWith(org.bookkeeper.mutation(api.journal.deleteDraft, { id: draft }), "FAILED_PRECONDITION");
    await rejectsWith(org.accountant.mutation(api.journal.post, { id: draft }), "FAILED_PRECONDITION");
    const view = await org.reviewer.query(api.journal.get, { id: draft });
    assert.equal(view!.entry.status, "posted");
    assert.equal(view!.lines.length, 2);
    assert.ok(view!.history.some((h) => h.type === "journal.posted"));
    await assertIntegrity(org);
  }));

test("reversal is a new mirrored entry; the original is preserved; a second reversal is refused", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const { acct } = org;
    const e = await org.accountant.mutation(api.journal.createAndPost, { date: "2026-04-01", description: "Misposted", lines: [dl(acct["6200"]!, 4500), cr(acct["1010"]!, 4500)] });
    const before = await org.reviewer.query(api.journal.get, { id: e.id });
    await rejectsWith(org.accountant.mutation(api.journal.reverse, { id: e.id, date: "2026-03-31", reason: "too early" }), "INVALID_ARGUMENT");
    await rejectsWith(org.bookkeeper.mutation(api.journal.reverse, { id: e.id, date: "2026-04-02", reason: "wrong account" }), "FORBIDDEN");
    const r = await org.accountant.mutation(api.journal.reverse, { id: e.id, date: "2026-04-02", reason: "Wrong account" });
    const after = await org.reviewer.query(api.journal.get, { id: e.id });
    assert.deepEqual(after!.lines.map((l) => [l.accountId, l.debit, l.credit]), before!.lines.map((l) => [l.accountId, l.debit, l.credit]), "original lines unchanged");
    assert.equal(after!.entry.__version, before!.entry.__version, "the original record was not touched");
    assert.equal(after!.reversedBy!.id, r.id);
    const rev = await org.reviewer.query(api.journal.get, { id: r.id });
    assert.equal(rev!.entry.reason, "Wrong account");
    assert.deepEqual(rev!.lines.map((l) => [l.accountId, l.debit, l.credit]).sort(), before!.lines.map((l) => [l.accountId, l.credit, l.debit]).sort());
    await rejectsWith(org.accountant.mutation(api.journal.reverse, { id: e.id, date: "2026-04-03", reason: "again" }), "FAILED_PRECONDITION", /already reversed/);
    await rejectsWith(org.accountant.mutation(api.journal.reverse, { id: r.id, date: "2026-04-03", reason: "undo" }), "FAILED_PRECONDITION", /itself a reversal/);
    assert.ok((await org.reviewer.query(api.accounts.list, {})).every((a) => a.balanceMinor === 0));
    await assertIntegrity(org);
  }));

test("closed periods reject postings and reversals dated in them; reopening needs a reason and authority", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const { acct } = org;
    const jan = await org.accountant.mutation(api.journal.createAndPost, { date: "2026-01-15", description: "Jan sale", lines: [dl(acct["1010"]!, 10000), cr(acct["4000"]!, 10000)] });
    await rejectsWith(org.bookkeeper.mutation(api.org.closePeriod, { through: "2026-01-31" }), "FORBIDDEN");
    await rejectsWith(org.reviewer.mutation(api.org.closePeriod, { through: "2026-01-31" }), "FORBIDDEN");
    await org.accountant.mutation(api.org.closePeriod, { through: "2026-01-31", reason: "January closed" });
    await rejectsWith(org.accountant.mutation(api.journal.createAndPost, { date: "2026-01-31", description: "Late", lines: [dl(acct["1010"]!, 1), cr(acct["4000"]!, 1)] }), "FAILED_PRECONDITION", /closed through 2026-01-31/);
    const draft = await org.bookkeeper.mutation(api.journal.createDraft, { date: "2026-01-20", description: "Backdated", lines: [dl(acct["1010"]!, 1), cr(acct["4000"]!, 1)] });
    await rejectsWith(org.accountant.mutation(api.journal.post, { id: draft }), "FAILED_PRECONDITION");
    // A reversal dated in the closed period is refused; dated after, it is fine.
    await rejectsWith(org.accountant.mutation(api.journal.reverse, { id: jan.id, date: "2026-01-20", reason: "x" + "yz" }), "FAILED_PRECONDITION");
    await org.accountant.mutation(api.journal.createAndPost, { date: "2026-02-01", description: "Feb", lines: [dl(acct["1010"]!, 1), cr(acct["4000"]!, 1)] });
    await rejectsWith(org.accountant.mutation(api.org.closePeriod, { through: "2026-02-28" }), "FAILED_PRECONDITION", /draft/);
    await org.bookkeeper.mutation(api.journal.deleteDraft, { id: draft });
    await rejectsWith(org.accountant.mutation(api.org.reopenPeriod, { to: "2026-01-31", reason: "same" }), "INVALID_ARGUMENT");
    await rejectsWith(org.bookkeeper.mutation(api.org.reopenPeriod, { to: "", reason: "fix january" }), "FORBIDDEN");
    await org.accountant.mutation(api.org.reopenPeriod, { to: "", reason: "Missed a January invoice" });
    await org.accountant.mutation(api.journal.createAndPost, { date: "2026-01-31", description: "Late, after reopening", lines: [dl(acct["1010"]!, 1), cr(acct["4000"]!, 1)] });
    const history = await org.reviewer.query(api.org.periodHistory, {});
    assert.deepEqual(history.map((h) => h.action), ["reopen", "close"]);
    assert.equal(history[0]!.reason, "Missed a January invoice");
    await assertIntegrity(org);
  }));

test("opening balances post one entry balanced by Opening Balance Equity", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const { acct } = org;
    await org.accountant.mutation(api.accounts.setOpeningBalances, {
      date: "2025-12-31",
      balances: [{ accountId: acct["1010"]!, balanceMinor: 1250000 }, { accountId: acct["2100"]!, balanceMinor: 30000 }, { accountId: acct["2500"]!, balanceMinor: 500000 }],
    });
    const b = Object.fromEntries((await org.reviewer.query(api.accounts.list, {})).map((x) => [x.number, x.balanceMinor]));
    assert.equal(b["1010"], 1250000);
    assert.equal(b["2100"], 30000);
    assert.equal(b["2500"], 500000);
    assert.equal(b["3900"], 720000);
    const bs = await org.reviewer.query(api.reports.balanceSheet, { asOf: "2026-01-01" });
    assert.equal(bs.balanced, true);
    await assertIntegrity(org);
  }));

test("idempotency: the same key posts once", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const { acct } = org;
    const args = { date: "2026-05-01", description: "Retry me", lines: [dl(acct["6600"]!, 2900), cr(acct["2100"]!, 2900)], idempotencyKey: "client-req-0001" };
    const first = await org.accountant.mutation(api.journal.createAndPost, args);
    const second = await org.accountant.mutation(api.journal.createAndPost, args);
    assert.equal(second.id, first.id);
    assert.equal(second.replayed, true);
    assert.equal((await org.reviewer.query(api.journal.list, { status: "posted" })).length, 1);
    await assertIntegrity(org);
  }));

test("concurrency: simultaneous postings each commit once with distinct numbers; a concurrent close admits nothing into the closed period", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    const { acct } = org;
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        org.accountant.mutation(api.journal.createAndPost, { date: "2026-06-10", description: `Concurrent ${i}`, lines: [dl(acct["6900"]!, 100 + i), cr(acct["1010"]!, 100 + i)] })),
    );
    const ok = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ number: number }>).value.number);
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    for (const f of failed) assert.equal(f.reason.code, "CONFLICT");
    assert.equal(new Set(ok).size, ok.length, "no duplicate numbers");
    await assertIntegrity(org);

    // Race a period close against postings dated inside the period being closed.
    const race = await Promise.allSettled([
      org.accountant.mutation(api.org.closePeriod, { through: "2026-06-30" }),
      ...Array.from({ length: 6 }, (_, i) => org.accountant.mutation(api.journal.createAndPost, { date: "2026-06-20", description: `Racing ${i}`, lines: [dl(acct["6900"]!, 7), cr(acct["1010"]!, 7)] })),
    ]);
    // FeltDB's commit revisions order the commits: every racing posting that succeeded must have
    // committed before the close did, since it is dated inside the closed period.
    const closes = (await t.runtime.activity.list({ name: "org:closePeriod", outcome: "success" }));
    const posts = (await t.runtime.activity.list({ name: "journal:createAndPost", outcome: "success" })).filter((e) => e.commitRevision !== undefined);
    if (race[0]!.status === "fulfilled") {
      assert.equal((await org.reviewer.query(api.org.settings, {}))!.closedThrough, "2026-06-30");
      assert.equal(closes.length, 1);
      const closeRev = closes[0]!.commitRevision!;
      assert.ok(closeRev !== undefined);
      // Every posting in this test is dated in June, inside the closed period.
      assert.ok(posts.length >= ok.length);
      for (const p of posts) assert.ok(p.commitRevision! < closeRev, `a posting committed at ${p.commitRevision} after the close at ${closeRev}`);
    }
    // Whatever interleaving happened, every refusal was a conflict or the closed-period rule.
    for (const r of race) if (r.status === "rejected") assert.ok(["CONFLICT", "FAILED_PRECONDITION"].includes((r as PromiseRejectedResult).reason.code));
    await assertIntegrity(org);
  }));

test("property: random valid and invalid entries keep every invariant (seeded)", () =>
  withApp(async (t) => {
    const org = await newOrg(t);
    // Every account except the AR/AP control accounts, which only their documents may post to.
    const ids = Object.entries(org.acct).filter(([n]) => n !== "1100" && n !== "2000").map(([, id]) => id);
    const r = rng(20261111);
    let posted = 0;
    let refused = 0;
    const expected = new Map<string, number>(); // accountId → debits − credits
    for (let i = 0; i < 60; i++) {
      const n = r.int(2, 5);
      const lines = Array.from({ length: n - 1 }, () => {
        const amount = r.int(1, 1_000_000);
        return r.next() < 0.5 ? dl(r.pick(ids), amount) : cr(r.pick(ids), amount);
      });
      const net = lines.reduce((t, l) => t + l.debit - l.credit, 0);
      const corrupt = r.next() < 0.25;
      const fix = net + (corrupt ? r.int(1, 50) : 0);
      if (fix === 0) continue;
      lines.push(fix > 0 ? cr(r.pick(ids), fix) : dl(r.pick(ids), -fix));
      try {
        await org.accountant.mutation(api.journal.createAndPost, { date: `2026-0${r.int(1, 9)}-1${r.int(0, 9)}`, description: `Random ${i}`, lines });
        assert.ok(!corrupt, "an unbalanced entry posted");
        for (const l of lines) expected.set(l.accountId, (expected.get(l.accountId) ?? 0) + l.debit - l.credit);
        posted++;
      } catch (e: any) {
        assert.ok(corrupt, `a balanced entry was refused: ${e.message}`);
        assert.equal(e.code, "INVALID_ARGUMENT");
        refused++;
      }
    }
    assert.ok(posted > 20 && refused > 5, `exercised both paths (${posted} posted, ${refused} refused)`);
    // Account balances equal the sum of posted entries.
    for (const a of await org.reviewer.query(api.accounts.list, {})) {
      assert.equal(a.debitMinor - a.creditMinor, expected.get(a.id) ?? 0, `account ${a.number}`);
    }
    // Reverse a random sample: balances move back by exactly those entries.
    const entries = await org.reviewer.query(api.journal.list, { status: "posted" });
    for (const e of entries.slice(0, 5)) await org.accountant.mutation(api.journal.reverse, { id: e.id, date: "2026-12-31", reason: "property test" });
    const tb = await org.reviewer.query(api.reports.trialBalance, { asOf: "2026-12-31" });
    assert.equal(tb.totalDebitMinor, tb.totalCreditMinor);
    const bs = await org.reviewer.query(api.reports.balanceSheet, { asOf: "2026-12-31" });
    assert.equal(bs.balanced, true, `assets ${bs.totalAssetsMinor} vs L+E ${bs.totalLiabilitiesAndEquityMinor}`);
    await assertIntegrity(org);
  }));
