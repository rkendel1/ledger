/**
 * Manual journal entries: drafts (editable, deletable, never in reports), posting, reversal.
 */
import { fail, s } from "@feltdb/feltkit";
import { accounts, app, audit, journalEntries, ledgerLines } from "./app.js";
import { actor, entryLines, postEntry, requireActiveAccounts, requireDate, requireSettings, reverseEntry, validateLines } from "./_ledger.js";

const lineArg = s.object({
  accountId: s.string(),
  debit: s.integer({ minimum: 0 }),
  credit: s.integer({ minimum: 0 }),
  memo: s.optional(s.string({ maxLength: 300 })),
  contactId: s.optional(s.string()),
});

/** Strip absent optionals so stored lines carry no `undefined` fields. */
function cleanLines(lines: ReadonlyArray<{ accountId: string; debit: number; credit: number; memo?: string; contactId?: string }>) {
  return lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, ...(l.memo ? { memo: l.memo } : {}), ...(l.contactId ? { contactId: l.contactId } : {}) }));
}

/** Save a draft. A draft must already balance, so it can be posted as is; it changes no balance. */
export const createDraft = app.mutation({
  access: "journal.draft",
  args: { date: s.string(), description: s.string({ minLength: 1, maxLength: 300 }), reference: s.optional(s.string({ maxLength: 120 })), lines: s.array(lineArg, { minItems: 2 }) },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    requireDate(a.date);
    const total = validateLines(a.lines);
    await requireActiveAccounts(ctx, a.lines.map((l) => l.accountId));
    const id = await ctx.db.insert(journalEntries, {
      number: 0, status: "draft", date: a.date, description: a.description.trim(), sourceType: "manual",
      draftLines: cleanLines(a.lines), totalMinor: total, createdBy: actor(ctx), createdAt: Date.now(),
      ...(a.reference ? { reference: a.reference } : {}),
    });
    await audit.record(ctx, { subject: "journal", id, type: "journal.drafted", data: { date: a.date, totalMinor: total } });
    return id;
  },
});

export const updateDraft = app.mutation({
  access: "journal.draft",
  args: { id: s.string(), date: s.string(), description: s.string({ minLength: 1, maxLength: 300 }), reference: s.optional(s.string({ maxLength: 120 })), lines: s.array(lineArg, { minItems: 2 }) },
  handler: async (ctx, a) => {
    const draft = await ctx.db.get(journalEntries, a.id);
    if (!draft) fail("NOT_FOUND", "No such journal entry.");
    if (draft.status !== "draft") fail("FAILED_PRECONDITION", `Journal entry ${draft.number} is posted. Posted entries cannot be edited; reverse it and post a correction.`);
    requireDate(a.date);
    const total = validateLines(a.lines);
    await requireActiveAccounts(ctx, a.lines.map((l) => l.accountId));
    await ctx.db.patch(journalEntries, a.id, { date: a.date, description: a.description.trim(), draftLines: cleanLines(a.lines), totalMinor: total, ...(a.reference ? { reference: a.reference } : {}) });
    await audit.record(ctx, { subject: "journal", id: a.id, type: "journal.draft.updated", data: { date: a.date, totalMinor: total } });
    return { ok: true };
  },
});

export const deleteDraft = app.mutation({
  access: "journal.draft",
  args: { id: s.string() },
  handler: async (ctx, a) => {
    const draft = await ctx.db.get(journalEntries, a.id);
    if (!draft) fail("NOT_FOUND", "No such journal entry.");
    if (draft.status !== "draft") fail("FAILED_PRECONDITION", `Journal entry ${draft.number} is posted and cannot be deleted. Reverse it instead.`);
    await ctx.db.delete(journalEntries, a.id);
    await audit.record(ctx, { subject: "journal", id: a.id, type: "journal.draft.deleted", data: { date: draft.date, totalMinor: draft.totalMinor, description: draft.description } });
    return { ok: true };
  },
});

/** Post a draft: it gets its number and its lines reach the ledger. */
export const post = app.mutation({
  access: "journal.post",
  approval: "required",
  args: { id: s.string() },
  returns: s.object({ id: s.string(), number: s.integer() }),
  retry: { sequenceConflicts: 3 },
  capability: { name: "journal.post", description: "Post a draft journal entry to the ledger. People only; agents may propose." },
  handler: async (ctx, a) => {
    const draft = await ctx.db.get(journalEntries, a.id);
    if (!draft) fail("NOT_FOUND", "No such journal entry.");
    if (draft.status !== "draft") fail("FAILED_PRECONDITION", `Journal entry ${draft.number} is already posted.`);
    const entry = await postEntry(ctx, {
      draftId: draft.id, date: draft.date, description: draft.description, sourceType: draft.sourceType,
      lines: draft.draftLines ?? [],
      ...(draft.reference ? { reference: draft.reference } : {}),
      ...(draft.sourceId ? { sourceId: draft.sourceId } : {}),
    });
    return { id: entry.id, number: entry.number };
  },
});

/** Create and post in one step (with an optional idempotency key, so a retried request posts once). */
export const createAndPost = app.mutation({
  access: "journal.post",
  approval: "required",
  args: { date: s.string(), description: s.string({ minLength: 1, maxLength: 300 }), reference: s.optional(s.string({ maxLength: 120 })), lines: s.array(lineArg, { minItems: 2 }), idempotencyKey: s.optional(s.string({ minLength: 8, maxLength: 120 })) },
  returns: s.object({ id: s.string(), number: s.integer(), replayed: s.boolean() }),
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, a) => {
    if (a.idempotencyKey) {
      const [prior] = await ctx.db.find(journalEntries, { idempotencyKey: a.idempotencyKey });
      if (prior) return { id: prior.id, number: prior.number, replayed: true };
    }
    const entry = await postEntry(ctx, {
      date: a.date, description: a.description, sourceType: "manual", lines: cleanLines(a.lines),
      ...(a.reference ? { reference: a.reference } : {}),
      ...(a.idempotencyKey ? { idempotencyKey: a.idempotencyKey } : {}),
    });
    return { id: entry.id, number: entry.number, replayed: false };
  },
});

/** Reverse a posted entry with an explicit new entry. The original stays exactly as it was. */
export const reverse = app.mutation({
  access: "journal.reverse",
  approval: "required",
  args: { id: s.string(), date: s.string(), reason: s.string({ minLength: 3, maxLength: 500 }) },
  returns: s.object({ id: s.string(), number: s.integer() }),
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, a) => {
    const original = await ctx.db.get(journalEntries, a.id);
    if (original && !["manual", "opening_balance", "proposal", "reversal"].includes(original.sourceType)) {
      fail("FAILED_PRECONDITION", `Entry ${original.number} was posted by a ${original.sourceType.replace("_", " ")}. Correct it from that document (void, credit note, or unmatch) so the document and the ledger stay in step.`);
    }
    const entry = await reverseEntry(ctx, a.id, { date: a.date, reason: a.reason });
    return { id: entry.id, number: entry.number };
  },
});

/** One entry with its lines (draft lines for a draft, ledger lines once posted) and its reversal links. */
export const get = app.query({
  access: "journal.read",
  args: { id: s.string() },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const entry = await ctx.db.get(journalEntries, a.id);
    if (!entry) return null;
    const lines = entry.status === "posted" ? await entryLines(ctx, entry.id) : (entry.draftLines ?? []).map((l, i) => ({ ...l, lineNo: i + 1 }));
    const names = new Map<string, { number: string; name: string }>();
    for (const l of lines) {
      if (!names.has(l.accountId)) {
        const acc = await ctx.db.get(accounts, l.accountId);
        names.set(l.accountId, acc ? { number: acc.number, name: acc.name } : { number: "?", name: "Unknown" });
      }
    }
    const [reversedBy] = entry.status === "posted" ? await ctx.db.find(journalEntries, { reversalOf: entry.id }) : [];
    const reversalOf = entry.reversalOf ? await ctx.db.get(journalEntries, entry.reversalOf) : null;
    const history = await audit.history(ctx as never, "journal", entry.id);
    return {
      entry: { ...entry, draftLines: undefined },
      lines: lines.map((l) => ({ ...l, account: names.get(l.accountId)! })),
      reversedBy: reversedBy ? { id: reversedBy.id, number: reversedBy.number, date: reversedBy.date } : null,
      reversalOf: reversalOf ? { id: reversalOf.id, number: reversalOf.number, date: reversalOf.date } : null,
      history,
    };
  },
});

/** Journal entries, newest first: posted, drafts, or both. */
export const list = app.query({
  access: "journal.read",
  args: { status: s.optional(s.enum(["draft", "posted"] as const)), from: s.optional(s.string()), to: s.optional(s.string()), sourceType: s.optional(s.string()), limit: s.optional(s.integer({ minimum: 1, maximum: 1000 })) },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const rows = await ctx.db.find(journalEntries, a.status ? { status: a.status } : {});
    const reversed = new Set(rows.filter((r) => r.reversalOf).map((r) => r.reversalOf!));
    return rows
      .filter((r) => (!a.from || r.date >= a.from) && (!a.to || r.date <= a.to) && (!a.sourceType || r.sourceType === a.sourceType))
      .sort((x, y) => (x.date === y.date ? y.number - x.number || y.createdAt - x.createdAt : x.date < y.date ? 1 : -1))
      .slice(0, a.limit ?? 500)
      .map(({ draftLines, ...r }) => ({ ...r, lineCount: draftLines?.length ?? null, reversed: reversed.has(r.id) }));
  },
});

/** Lines for a set of entries, used by the UI to expand rows without one call per entry. */
export const linesFor = app.query({
  access: "journal.read",
  args: { entryIds: s.array(s.string(), { maxItems: 200 }) },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const out: Record<string, unknown[]> = {};
    for (const id of a.entryIds) out[id] = await ctx.db.find(ledgerLines, { entryId: id }, { orderBy: [{ field: "lineNo", direction: "asc" }] });
    return out;
  },
});
