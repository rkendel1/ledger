/**
 * Agentic bookkeeping, with the authority split the books need:
 *
 *   read      queries and report capabilities (any member, including the assistant agent)
 *   propose   proposals.create — Ledger's deterministic rules, or an agent over AppPort / MCP
 *   approve   proposals.decide + the action's own permission, by a person; never the proposer
 *   execute   in the approver's transaction, through the same code paths as the direct actions
 *
 * Every proposal keeps its input, rationale, evidence and source; the decision keeps who, when and
 * why; the executed result keeps the journal entry it produced. No model is needed for any of it:
 * the rules here are plain code, and the product works with no AI service configured.
 */
import { fail, s, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { PROPOSAL_ACTIONS, accounts, app, audit, bankAccounts, bankTransactions, bills, contacts, expenses, journalEntries, ledgerLines, proposals, receipts, reconciliations, type ProposalAction } from "./app.js";
import { daysBetween, postEntry, requireActiveAccounts, requireControlAccountsByWorkflow, requireDate, requireSettings, today, validateLines } from "./_ledger.js";
import { openBills, openInvoices } from "./_documents.js";
import { applyCategorize, applyMatch, candidateLines } from "./banking.js";
import { reportList } from "./_contracts.js";

type Ctx = QueryCtx | MutationCtx;

/** The permission an approver needs, besides proposals.decide, to execute each action. */
export const ACTION_PERMISSION: Record<ProposalAction, string> = {
  "bank.categorize": "banking.categorize",
  "bank.match": "banking.match",
  "journal.post": "journal.post",
};

interface Splits { bankTransactionId: string; splits: Array<{ accountId: string; amountMinor: number; memo?: string }> }
interface Match { bankTransactionId: string; ledgerLineIds: string[] }
interface Journal { date: string; description: string; lines: Array<{ accountId: string; debit: number; credit: number; memo?: string }> }

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail("INVALID_ARGUMENT", `${what} must be an object.`);
  return v as Record<string, unknown>;
}

/** Validate a proposal's input against the current books, without changing anything. Returns its subject key. */
async function check(ctx: Ctx, action: ProposalAction, input: Record<string, unknown>): Promise<string> {
  if (action === "bank.categorize" || action === "bank.match") {
    const txnId = String(input.bankTransactionId ?? "");
    const txn = await ctx.db.get(bankTransactions, txnId);
    if (!txn) fail("NOT_FOUND", "No such bank transaction.");
    if (txn.status !== "unmatched") fail("FAILED_PRECONDITION", `That bank transaction is ${txn.status}.`);
    if (action === "bank.categorize") {
      const { splits } = input as unknown as Splits;
      if (!Array.isArray(splits) || splits.length === 0) fail("INVALID_ARGUMENT", "A categorization needs splits.");
      const total = splits.reduce((t, x) => t + Number(x.amountMinor), 0);
      if (total !== Math.abs(txn.amountMinor)) fail("INVALID_ARGUMENT", `The splits total ${total}; the transaction is ${Math.abs(txn.amountMinor)}.`);
      const used = await requireActiveAccounts(ctx, splits.map((x) => String(x.accountId)));
      requireControlAccountsByWorkflow("bank", [...used.values()]);
    } else {
      const { ledgerLineIds } = input as unknown as Match;
      if (!Array.isArray(ledgerLineIds) || ledgerLineIds.length === 0) fail("INVALID_ARGUMENT", "A match names ledger lines.");
      let sum = 0;
      for (const id of ledgerLineIds) {
        const l = await ctx.db.get(ledgerLines, String(id));
        if (!l) fail("NOT_FOUND", "No such ledger line.");
        sum += l.debit - l.credit;
      }
      if (sum !== txn.amountMinor) fail("INVALID_ARGUMENT", `The lines total ${sum}; the transaction is ${txn.amountMinor}.`);
    }
    return `bank:${txn.id}`;
  }
  const j = input as unknown as Journal;
  requireDate(String(j.date));
  if (typeof j.description !== "string" || !j.description.trim()) fail("INVALID_ARGUMENT", "A journal proposal needs a description.");
  if (!Array.isArray(j.lines)) fail("INVALID_ARGUMENT", "A journal proposal needs lines.");
  validateLines(j.lines);
  const used = await requireActiveAccounts(ctx, j.lines.map((l) => String(l.accountId)));
  requireControlAccountsByWorkflow("proposal", [...used.values()]);
  return `journal:${j.date}:${j.description.trim().toLowerCase()}:${j.lines.reduce((t, l) => t + l.debit, 0)}`;
}

async function insertProposal(ctx: MutationCtx, p: { action: ProposalAction; input: Record<string, unknown>; summary: string; rationale: string; evidence: Record<string, unknown>; source: string }) {
  const subjectKey = await check(ctx, p.action, p.input);
  const [open] = (await ctx.db.find(proposals, { subjectKey })).filter((x) => x.status === "pending");
  if (open) return { id: open.id, created: false };
  const principal = ctx.auth.requirePrincipal();
  const id = await ctx.db.insert(proposals, {
    action: p.action, input: p.input, summary: p.summary.slice(0, 300), rationale: p.rationale.slice(0, 2000), evidence: p.evidence,
    source: p.source, proposedBy: principal.id, proposedByType: principal.type, subjectKey, status: "pending", createdAt: Date.now(),
  });
  await audit.record(ctx, { subject: "proposal", id, type: "proposal.created", data: { action: p.action, source: p.source, summary: p.summary, agent: principal.type === "agent" } });
  return { id, created: true };
}

/**
 * Propose an action for a person to approve. This is how an agent (or another application) asks for a
 * financial change: it can never execute one. Proposing the same thing twice returns the open proposal.
 */
export const propose = app.mutation({
  access: "proposals.create",
  args: {
    action: s.enum(PROPOSAL_ACTIONS),
    input: s.record(s.unknown()),
    summary: s.string({ minLength: 3, maxLength: 300 }),
    rationale: s.string({ minLength: 3, maxLength: 2000 }),
    evidence: s.optional(s.record(s.unknown())),
  },
  returns: s.object({ id: s.string(), created: s.boolean() }),
  capability: { name: "proposals.create", description: "Propose a categorization, bank match or journal entry for a person to approve. Executes nothing." },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const principal = ctx.auth.requirePrincipal();
    return insertProposal(ctx, { action: a.action, input: asObject(a.input, "input"), summary: a.summary, rationale: a.rationale, evidence: a.evidence ?? {}, source: `${principal.type}:${principal.id}` });
  },
});

/** Execute an approved proposal inside the approver's transaction. */
async function execute(ctx: MutationCtx, p: { id: string; action: ProposalAction; input: Record<string, unknown> }, approvedBy: string): Promise<Record<string, unknown>> {
  if (p.action === "bank.categorize") {
    const i = p.input as unknown as Splits;
    const r = await applyCategorize(ctx, i.bankTransactionId, i.splits.map((x) => ({ accountId: x.accountId, amountMinor: x.amountMinor, ...(x.memo ? { memo: x.memo } : {}) })), { proposalId: p.id, approvedBy });
    return { journalEntryId: r.journalEntryId, number: r.number };
  }
  if (p.action === "bank.match") {
    const i = p.input as unknown as Match;
    const txn = await applyMatch(ctx, i.bankTransactionId, i.ledgerLineIds);
    await audit.record(ctx, { subject: "bank", id: txn.id, type: "banktxn.matched", data: { ledgerLineIds: i.ledgerLineIds, proposalId: p.id } });
    return { bankTransactionId: txn.id, ledgerLineIds: i.ledgerLineIds };
  }
  const j = p.input as unknown as Journal;
  const entry = await postEntry(ctx, {
    date: j.date, description: j.description, sourceType: "proposal", sourceId: p.id, proposalId: p.id, approvedBy,
    lines: j.lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, ...(l.memo ? { memo: l.memo } : {}) })),
  });
  return { journalEntryId: entry.id, number: entry.number };
}

/**
 * Approve and execute a proposal. The approver must be a person, hold proposals.decide and the
 * action's own permission, and not be the proposer. If execution is refused (the books changed), the
 * whole call fails and the proposal stays pending, with nothing written.
 */
export const approve = app.mutation({
  access: "proposals.decide",
  approval: "required",
  args: { id: s.string(), reason: s.optional(s.string({ maxLength: 500 })) },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, a) => {
    const p = await ctx.db.get(proposals, a.id);
    if (!p) fail("NOT_FOUND", "No such proposal.");
    if (p.status !== "pending") fail("FAILED_PRECONDITION", `This proposal is already ${p.status}.`);
    const principal = ctx.auth.requirePrincipal();
    if (principal.type !== "user") fail("FORBIDDEN", "Only a person can approve a proposal.");
    if (p.proposedBy === principal.id) fail("FORBIDDEN", "A proposal is approved by someone other than its proposer.");
    ctx.auth.require(ACTION_PERMISSION[p.action]);
    await check(ctx, p.action, p.input);
    const result = await execute(ctx, { id: p.id, action: p.action, input: p.input }, principal.id);
    await ctx.db.patch(proposals, p.id, { status: "approved", decidedBy: principal.id, decidedAt: Date.now(), result, ...(a.reason ? { decisionReason: a.reason } : {}) });
    await audit.record(ctx, { subject: "proposal", id: p.id, type: "proposal.approved", data: { action: p.action, proposedBy: p.proposedBy, proposedByType: p.proposedByType, source: p.source, result, ...(a.reason ? { reason: a.reason } : {}) } });
    return { ok: true, result };
  },
});

export const reject = app.mutation({
  access: "proposals.decide",
  args: { id: s.string(), reason: s.string({ minLength: 3, maxLength: 500 }) },
  handler: async (ctx, a) => {
    const p = await ctx.db.get(proposals, a.id);
    if (!p) fail("NOT_FOUND", "No such proposal.");
    if (p.status !== "pending") fail("FAILED_PRECONDITION", `This proposal is already ${p.status}.`);
    const principal = ctx.auth.requirePrincipal();
    if (principal.type !== "user") fail("FORBIDDEN", "Only a person can decide a proposal.");
    await ctx.db.patch(proposals, p.id, { status: "rejected", decidedBy: principal.id, decidedAt: Date.now(), decisionReason: a.reason });
    await audit.record(ctx, { subject: "proposal", id: p.id, type: "proposal.rejected", data: { action: p.action, source: p.source, reason: a.reason } });
    return { ok: true };
  },
});

async function listProposals(ctx: Ctx, status?: "pending" | "approved" | "rejected" | "failed" | "superseded") {
  return (await ctx.db.find(proposals, status ? { status } : {})).sort((x, y) => y.createdAt - x.createdAt);
}

export const list = app.query({
  access: "proposals.read",
  args: { status: s.optional(s.enum(["pending", "approved", "rejected", "failed", "superseded"] as const)) },
  returns: reportList<Awaited<ReturnType<typeof listProposals>>[number]>(),
  capability: { name: "proposals.list", description: "Proposals and their decisions." },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    return listProposals(ctx, a.status);
  },
});

// ── Deterministic rules ─────────────────────────────────────────────────────────────────────

/** Accounts a payee was categorized to before (single-split categorizations only), most recent first. */
async function payeeHistory(ctx: Ctx) {
  const out = new Map<string, Array<{ accountId: string; date: string; txnId: string }>>();
  for (const t of await ctx.db.find(bankTransactions, { status: "matched" })) {
    if (!t.journalEntryId) continue;
    const lines = (await ctx.db.find(ledgerLines, { entryId: t.journalEntryId })).filter((l) => !t.matchedLineIds.includes(l.id));
    if (lines.length !== 1) continue;
    const list = out.get(t.payee) ?? [];
    list.push({ accountId: lines[0]!.accountId, date: t.date, txnId: t.id });
    out.set(t.payee, list);
  }
  for (const l of out.values()) l.sort((x, y) => (x.date < y.date ? 1 : -1));
  return out;
}

/**
 * Run Ledger's rules over unmatched bank transactions and create proposals:
 *   match       exactly one unmatched ledger line on the bank's account has the same amount within 5 days
 *   history     the same payee was categorized to the same account before (at least once, never otherwise)
 *   vendor      a vendor whose name appears in the description has a default account
 * Never proposes twice for the same transaction while a proposal is open.
 */
export const scan = app.mutation({
  access: "proposals.create",
  returns: s.object({ examined: s.integer(), proposed: s.integer() }),
  capability: { name: "review.scan", description: "Run Ledger's deterministic bookkeeping rules and create proposals for review." },
  handler: async (ctx) => {
    await requireSettings(ctx);
    const history = await payeeHistory(ctx);
    const vendors = (await ctx.db.find(contacts, { kind: "vendor" })).filter((v) => v.defaultAccountId && v.active);
    const accountNames = new Map((await ctx.db.find(accounts, {})).map((x) => [x.id, `${x.number} ${x.name}`]));
    let examined = 0;
    let proposed = 0;
    for (const ba of await ctx.db.find(bankAccounts, {})) {
      for (const txn of await ctx.db.find(bankTransactions, { bankAccountId: ba.id, status: "unmatched" })) {
        examined++;
        if ((await ctx.db.find(proposals, { subjectKey: `bank:${txn.id}` })).some((p) => p.status === "pending")) continue;
        const cands = (await candidateLines(ctx, txn, 5));
        if (cands.length === 1) {
          const c = cands[0]!;
          const r = await insertProposal(ctx, {
            action: "bank.match", input: { bankTransactionId: txn.id, ledgerLineIds: [c.lineId] },
            summary: `Match ${txn.description} to entry #${c.entryNumber}`,
            rationale: `Entry #${c.entryNumber} (${c.description}) moved the same amount through ${ba.name} ${c.dayGap === 0 ? "the same day" : `${c.dayGap} day${c.dayGap === 1 ? "" : "s"} apart`}, and no other unmatched line does.`,
            evidence: { bankTransaction: { id: txn.id, date: txn.date, amountMinor: txn.amountMinor, description: txn.description }, ledgerLine: c },
            source: "rules:match",
          });
          if (r.created) proposed++;
          continue;
        }
        if (cands.length > 1) continue; // ambiguous: a person chooses
        const past = history.get(txn.payee) ?? [];
        const distinct = new Set(past.map((p) => p.accountId));
        let accountId: string | undefined;
        let rationale = "";
        let source = "";
        let evidence: Record<string, unknown> = {};
        if (past.length >= 1 && distinct.size === 1) {
          accountId = past[0]!.accountId;
          source = "rules:history";
          rationale = `"${txn.payee}" was categorized to ${accountNames.get(accountId)} ${past.length} time${past.length === 1 ? "" : "s"} before, and never elsewhere.`;
          evidence = { previous: past.slice(0, 5) };
        } else {
          const v = vendors.find((x) => txn.description.toLowerCase().includes(x.name.toLowerCase()));
          if (v) {
            accountId = v.defaultAccountId!;
            source = "rules:vendor";
            rationale = `The description names vendor ${v.name}, whose default account is ${accountNames.get(accountId)}.`;
            evidence = { vendorId: v.id };
          }
        }
        if (!accountId) continue;
        const r = await insertProposal(ctx, {
          action: "bank.categorize", input: { bankTransactionId: txn.id, splits: [{ accountId, amountMinor: Math.abs(txn.amountMinor) }] },
          summary: `Categorize ${txn.description} to ${accountNames.get(accountId)}`,
          rationale, source, evidence: { bankTransaction: { id: txn.id, date: txn.date, amountMinor: txn.amountMinor, description: txn.description, payee: txn.payee }, ...evidence },
        });
        if (r.created) proposed++;
      }
    }
    return { examined, proposed };
  },
});

// ── The review queue ───────────────────────────────────────────────────────────────────────

export interface ReviewItem {
  kind: string;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  link: { type: string; id: string };
  amountMinor?: number;
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
}

export async function reviewItems(ctx: Ctx, asOf: string, options: { receiptThresholdMinor: number }) {
  const items: ReviewItem[] = [];
  const pending = (await ctx.db.find(proposals, { status: "pending" })).sort((x, y) => y.createdAt - x.createdAt);
  for (const p of pending) items.push({ kind: "proposal", severity: "medium", title: p.summary, detail: `${p.source.startsWith("rules:") ? "Ledger rule" : `Proposed by ${p.proposedBy}`}: ${p.rationale}`, link: { type: "proposal", id: p.id } });

  // Possible duplicate bank transactions: same account, amount and payee within 3 days.
  for (const ba of await ctx.db.find(bankAccounts, {})) {
    const txns = (await ctx.db.find(bankTransactions, { bankAccountId: ba.id })).filter((t) => t.status !== "excluded").sort((x, y) => (x.date < y.date ? -1 : 1));
    for (let i = 0; i < txns.length; i++) {
      for (let j = i + 1; j < txns.length && daysBetween(txns[i]!.date, txns[j]!.date) <= 3; j++) {
        const a = txns[i]!;
        const b = txns[j]!;
        if (a.amountMinor === b.amountMinor && a.payee === b.payee && (a.status === "unmatched" || b.status === "unmatched")) {
          items.push({ kind: "duplicate", severity: "medium", title: `Possible duplicate: ${b.description}`, detail: `${ba.name}: ${(Math.abs(b.amountMinor) / 100).toFixed(2)} on ${a.date} and ${b.date}. Exclude one if the bank charged once.`, link: { type: "bankTransaction", id: b.id }, amountMinor: b.amountMinor });
        }
      }
    }
    const unmatched = txns.filter((t) => t.status === "unmatched");
    if (unmatched.length) items.push({ kind: "unmatched", severity: unmatched.length > 20 ? "high" : "low", title: `${unmatched.length} unmatched transaction${unmatched.length === 1 ? "" : "s"} in ${ba.name}`, detail: `Oldest from ${unmatched[0]!.date}. Match or categorize them.`, link: { type: "bankAccount", id: ba.id } });
    // Payee anomaly: far larger than this payee's other transactions.
    for (const t of unmatched) {
      const others = txns.filter((o) => o.payee === t.payee && o.id !== t.id).map((o) => Math.abs(o.amountMinor));
      const m = median(others);
      if (others.length >= 3 && Math.abs(t.amountMinor) > 3 * m) items.push({ kind: "unusual", severity: "medium", title: `Unusually large: ${t.description}`, detail: `${(Math.abs(t.amountMinor) / 100).toFixed(2)} is more than three times this payee's usual ${(m / 100).toFixed(2)}.`, link: { type: "bankTransaction", id: t.id }, amountMinor: t.amountMinor });
    }
    const recs = (await ctx.db.find(reconciliations, { bankAccountId: ba.id })).filter((r) => r.status === "completed").sort((x, y) => (x.statementEnd < y.statementEnd ? 1 : -1));
    const last = recs[0]?.statementEnd;
    if (!last || daysBetween(last, asOf) > 45) items.push({ kind: "reconcile", severity: "low", title: `Reconcile ${ba.name}`, detail: last ? `Last reconciled through ${last}.` : "Never reconciled.", link: { type: "bankAccount", id: ba.id } });
  }

  // Expense-account anomalies among posted lines: more than three times the account's median.
  const expenseAccounts = (await ctx.db.find(accounts, { type: "expense" }));
  for (const acc of expenseAccounts) {
    const lines = (await ctx.db.find(ledgerLines, { accountId: acc.id })).filter((l) => l.debit > 0).sort((x, y) => (x.date < y.date ? -1 : 1));
    for (let i = 4; i < lines.length; i++) {
      const m = median(lines.slice(0, i).map((l) => l.debit));
      if (lines[i]!.debit > 3 * m && lines[i]!.date >= addDaysSafe(asOf, -90)) {
        items.push({ kind: "unusual", severity: "medium", title: `Unusual ${acc.name} entry #${lines[i]!.entryNumber}`, detail: `${(lines[i]!.debit / 100).toFixed(2)} is more than three times the usual ${(m / 100).toFixed(2)} for this account.`, link: { type: "journal", id: lines[i]!.entryId }, amountMinor: lines[i]!.debit });
      }
    }
  }

  // Missing receipts on expenses above the threshold.
  const withReceipts = new Set((await ctx.db.find(receipts, { subjectType: "expense" })).map((r) => r.subjectId));
  for (const e of await ctx.db.find(expenses, {})) {
    if (e.status !== "rejected" && e.amountMinor >= options.receiptThresholdMinor && !withReceipts.has(e.id)) {
      items.push({ kind: "receipt", severity: e.status === "approved" ? "medium" : "low", title: `Missing receipt: ${e.description}`, detail: `${(e.amountMinor / 100).toFixed(2)} on ${e.date} has no receipt attached.`, link: { type: "expense", id: e.id }, amountMinor: e.amountMinor });
    }
    if (e.status === "draft") items.push({ kind: "approval", severity: "low", title: `Expense awaiting approval: ${e.description}`, detail: `${(e.amountMinor / 100).toFixed(2)} recorded by ${e.createdBy}.`, link: { type: "expense", id: e.id }, amountMinor: e.amountMinor });
  }
  for (const b of await ctx.db.find(bills, { status: "draft" })) items.push({ kind: "approval", severity: "low", title: `Bill awaiting approval: ${b.billNumber}`, detail: `${(b.totalMinor / 100).toFixed(2)}, due ${b.dueDate}.`, link: { type: "bill", id: b.id }, amountMinor: b.totalMinor });
  for (const b of await ctx.db.find(bills, { status: "approved" })) items.push({ kind: "approval", severity: "low", title: `Approved bill not posted: ${b.billNumber}`, detail: `${(b.totalMinor / 100).toFixed(2)}, due ${b.dueDate}.`, link: { type: "bill", id: b.id }, amountMinor: b.totalMinor });
  for (const d of await ctx.db.find(journalEntries, { status: "draft" })) items.push({ kind: "approval", severity: "low", title: `Draft journal entry: ${d.description}`, detail: `Dated ${d.date}, ${(d.totalMinor / 100).toFixed(2)}.`, link: { type: "journal", id: d.id }, amountMinor: d.totalMinor });

  for (const i of await openInvoices(ctx, asOf)) if (i.dueDate < asOf) items.push({ kind: "overdue_invoice", severity: daysBetween(i.dueDate, asOf) > 30 ? "high" : "medium", title: `Invoice ${i.number} is overdue`, detail: `${(i.balanceMinor / 100).toFixed(2)} was due ${i.dueDate} (${daysBetween(i.dueDate, asOf)} days ago).`, link: { type: "invoice", id: i.id }, amountMinor: i.balanceMinor });
  for (const b of await openBills(ctx, asOf)) if (b.dueDate < asOf) items.push({ kind: "overdue_bill", severity: "high", title: `Bill ${b.billNumber} is overdue`, detail: `${(b.balanceMinor / 100).toFixed(2)} was due ${b.dueDate}.`, link: { type: "bill", id: b.id }, amountMinor: b.balanceMinor });

  const rank = { high: 0, medium: 1, low: 2 };
  return items.sort((x, y) => rank[x.severity] - rank[y.severity]);
}

function addDaysSafe(day: string, days: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const queue = app.query({
  access: "proposals.read",
  args: { asOf: s.optional(s.string()), receiptThresholdMinor: s.optional(s.integer({ minimum: 0 })) },
  returns: reportList<ReviewItem>(),
  capability: { name: "review.queue", description: "The bookkeeping review queue: proposals, possible duplicates, unusual amounts, missing receipts, approvals, overdue documents, reconciliation." },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    return reviewItems(ctx, requireDate(a.asOf ?? today(), "asOf"), { receiptThresholdMinor: a.receiptThresholdMinor ?? 7500 });
  },
});

