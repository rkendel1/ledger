/**
 * The chart of accounts, opening balances, and account histories (the general ledger).
 */
import { fail, s } from "@feltdb/feltkit";
import { ACCOUNT_SUBTYPES, ACCOUNT_TYPES, accounts, app, audit, ledgerLines, type AccountSubtype, type AccountType } from "./app.js";
import { normalBalance, patchRemoving, postEntry, requireDate, requireSettings, systemAccount, requirePerson } from "./_ledger.js";

/** Which subtypes belong to which type. */
export const SUBTYPES_BY_TYPE: Record<AccountType, AccountSubtype[]> = {
  asset: ["cash", "bank", "receivable", "other_current_asset", "fixed_asset"],
  liability: ["payable", "credit_card", "tax_payable", "other_current_liability", "long_term_liability"],
  equity: ["equity", "retained_earnings", "opening_balance"],
  revenue: ["revenue", "other_income"],
  expense: ["cost_of_sales", "expense"],
};

const accountOut = s.object({
  id: s.string(),
  number: s.string(),
  name: s.string(),
  type: s.enum(ACCOUNT_TYPES),
  subtype: s.enum(ACCOUNT_SUBTYPES),
  parentId: s.optional(s.string()),
  description: s.optional(s.string()),
  active: s.boolean(),
  system: s.boolean(),
  debitMinor: s.integer(),
  creditMinor: s.integer(),
  balanceMinor: s.integer(),
});

/** Every account with its posted totals and its balance in the account's normal direction. */
export const list = app.query({
  access: "accounts.read",
  args: { includeInactive: s.optional(s.boolean()) },
  returns: s.array(accountOut),
  capability: { name: "accounts.list", description: "The chart of accounts with posted balances." },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const all = await ctx.db.find(accounts, {}, { orderBy: [{ field: "number", direction: "asc" }] });
    const lines = await ctx.db.find(ledgerLines, {});
    const totals = new Map<string, { d: number; c: number }>();
    for (const l of lines) {
      const t = totals.get(l.accountId) ?? { d: 0, c: 0 };
      t.d += l.debit;
      t.c += l.credit;
      totals.set(l.accountId, t);
    }
    return all
      .filter((x) => a.includeInactive || x.active)
      .map((x) => {
        const t = totals.get(x.id) ?? { d: 0, c: 0 };
        return {
          id: x.id, number: x.number, name: x.name, type: x.type, subtype: x.subtype, active: x.active, system: x.system,
          ...(x.parentId ? { parentId: x.parentId } : {}),
          ...(x.description ? { description: x.description } : {}),
          debitMinor: t.d, creditMinor: t.c, balanceMinor: normalBalance(x.type, t.d, t.c),
        };
      });
  },
});

async function checkParent(ctx: Parameters<typeof list.handler>[0], parentId: string | undefined, type: AccountType, selfId?: string) {
  if (!parentId) return;
  if (parentId === selfId) fail("INVALID_ARGUMENT", "An account cannot be its own parent.");
  const parent = await ctx.db.get(accounts, parentId);
  if (!parent) fail("INVALID_ARGUMENT", "Unknown parent account.");
  if (parent.type !== type) fail("INVALID_ARGUMENT", `A ${type} account cannot sit under a ${parent.type} account.`);
  if (parent.parentId) fail("INVALID_ARGUMENT", "Accounts nest one level deep.");
}

export const create = app.mutation({
  access: "accounts.write",
  args: {
    number: s.string({ pattern: "^[0-9]{3,8}$" }),
    name: s.string({ minLength: 1, maxLength: 120 }),
    type: s.enum(ACCOUNT_TYPES),
    subtype: s.enum(ACCOUNT_SUBTYPES),
    parentId: s.optional(s.string()),
    description: s.optional(s.string({ maxLength: 500 })),
  },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    if (!SUBTYPES_BY_TYPE[a.type].includes(a.subtype)) fail("INVALID_ARGUMENT", `${a.subtype} is not a kind of ${a.type} account.`);
    if (["receivable", "payable", "retained_earnings", "opening_balance"].includes(a.subtype)) {
      fail("INVALID_ARGUMENT", `Each organization has one ${a.subtype.replace("_", " ")} account, created at setup.`);
    }
    await checkParent(ctx, a.parentId, a.type);
    const [dup] = await ctx.db.find(accounts, { number: a.number });
    if (dup) fail("CONFLICT", `Account number ${a.number} is already used by ${dup.name}.`);
    const id = await ctx.db.insert(accounts, {
      number: a.number, name: a.name.trim(), type: a.type, subtype: a.subtype, active: true, system: false, createdAt: Date.now(),
      ...(a.parentId ? { parentId: a.parentId } : {}),
      ...(a.description ? { description: a.description } : {}),
    });
    await audit.record(ctx, { subject: "account", id, type: "account.created", data: { number: a.number, name: a.name, type: a.type, subtype: a.subtype } });
    return id;
  },
});

/**
 * Rename, renumber, describe, re-parent or (de)activate an account. Its type cannot change once it
 * has posted lines, because that would silently move history between statements.
 */
export const update = app.mutation({
  access: "accounts.write",
  args: {
    id: s.string(),
    number: s.optional(s.string({ pattern: "^[0-9]{3,8}$" })),
    name: s.optional(s.string({ minLength: 1, maxLength: 120 })),
    subtype: s.optional(s.enum(ACCOUNT_SUBTYPES)),
    parentId: s.optional(s.nullable(s.string())),
    description: s.optional(s.string({ maxLength: 500 })),
    active: s.optional(s.boolean()),
  },
  handler: async (ctx, a) => {
    const account = await ctx.db.get(accounts, a.id);
    if (!account) fail("NOT_FOUND", "No such account.");
    if (a.number && a.number !== account.number) {
      const [dup] = await ctx.db.find(accounts, { number: a.number });
      if (dup) fail("CONFLICT", `Account number ${a.number} is already used by ${dup.name}.`);
    }
    if (a.subtype && a.subtype !== account.subtype) {
      if (account.system) fail("FAILED_PRECONDITION", "A system account's kind cannot change.");
      if (!SUBTYPES_BY_TYPE[account.type].includes(a.subtype)) fail("INVALID_ARGUMENT", `${a.subtype} is not a kind of ${account.type} account.`);
      if (["receivable", "payable", "retained_earnings", "opening_balance"].includes(a.subtype)) fail("INVALID_ARGUMENT", "That kind of account is created at setup.");
    }
    if (a.active === false && account.system) fail("FAILED_PRECONDITION", `${account.name} is used by Ledger's workflows and cannot be deactivated.`);
    if (a.parentId) await checkParent(ctx, a.parentId, account.type, account.id);
    const patch = {
      ...(a.number ? { number: a.number } : {}),
      ...(a.name ? { name: a.name.trim() } : {}),
      ...(a.subtype ? { subtype: a.subtype } : {}),
      ...(a.parentId ? { parentId: a.parentId } : {}),
      ...(a.description !== undefined ? { description: a.description } : {}),
      ...(a.active !== undefined ? { active: a.active } : {}),
    };
    if (a.parentId === null) await patchRemoving(ctx, accounts, a.id, patch, ["parentId"]);
    else await ctx.db.patch(accounts, a.id, patch as never);
    await audit.record(ctx, { subject: "account", id: a.id, type: "account.updated", data: { before: { number: account.number, name: account.name, subtype: account.subtype, active: account.active }, changes: { ...patch, ...(a.parentId === null ? { parentId: null } : {}) } } });
    return { ok: true };
  },
});

/**
 * Opening balances: one posted entry, dated the day before the books start, that sets each listed
 * account's balance and puts the difference in Opening Balance Equity.
 */
export const setOpeningBalances = app.mutation({
  access: "journal.post",
  args: {
    date: s.string(),
    balances: s.array(s.object({ accountId: s.string(), balanceMinor: s.integer() }), { minItems: 1 }),
    idempotencyKey: s.optional(s.string({ maxLength: 120 })),
  },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, a) => {
    requirePerson(ctx);
    requireDate(a.date);
    const equity = await systemAccount(ctx, "opening_balance");
    const lines: { accountId: string; debit: number; credit: number; memo: string }[] = [];
    let net = 0; // debits − credits
    for (const b of a.balances) {
      const account = await ctx.db.get(accounts, b.accountId);
      if (!account) fail("INVALID_ARGUMENT", `Unknown account ${b.accountId}.`);
      if (account.id === equity.id) fail("INVALID_ARGUMENT", "Opening Balance Equity is the balancing account; do not list it.");
      if (account.system && (account.subtype === "receivable" || account.subtype === "payable")) fail("INVALID_ARGUMENT", `${account.name}: enter open invoices and bills as documents, not as an opening balance.`);
      if (account.type === "revenue" || account.type === "expense") fail("INVALID_ARGUMENT", `${account.name}: opening balances are for balance-sheet accounts.`);
      if (b.balanceMinor === 0) continue;
      // A positive balance is in the account's normal direction.
      const debit = (account.type === "asset") === b.balanceMinor > 0;
      const amount = Math.abs(b.balanceMinor);
      lines.push({ accountId: account.id, debit: debit ? amount : 0, credit: debit ? 0 : amount, memo: "Opening balance" });
      net += debit ? amount : -amount;
    }
    if (lines.length === 0) fail("INVALID_ARGUMENT", "Every balance is zero.");
    if (net !== 0) lines.push({ accountId: equity.id, debit: net < 0 ? -net : 0, credit: net > 0 ? net : 0, memo: "Opening balance offset" });
    if (lines.length < 2) fail("INVALID_ARGUMENT", "Opening balances need a balancing line.");
    const entry = await postEntry(ctx, { date: a.date, description: "Opening balances", sourceType: "opening_balance", lines, ...(a.idempotencyKey ? { idempotencyKey: a.idempotencyKey } : {}) });
    return { journalEntryId: entry.id, number: entry.number };
  },
});

/** One account's posted lines in date order with a running balance (the general ledger for that account). */
export const history = app.query({
  access: "accounts.read",
  args: { accountId: s.string(), from: s.optional(s.string()), to: s.optional(s.string()) },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const account = await ctx.db.get(accounts, a.accountId);
    if (!account) fail("NOT_FOUND", "No such account.");
    const lines = (await ctx.db.find(ledgerLines, { accountId: a.accountId }))
      .sort((x, y) => (x.date === y.date ? x.entryNumber - y.entryNumber || x.lineNo - y.lineNo : x.date < y.date ? -1 : 1));
    let opening = 0;
    let running = 0;
    const rows: Array<{ lineId: string; entryId: string; entryNumber: number; date: string; memo?: string; sourceType: string; debit: number; credit: number; balance: number }> = [];
    for (const l of lines) {
      const delta = normalBalance(account.type, l.debit, l.credit);
      if (a.from && l.date < a.from) {
        opening += delta;
        running += delta;
        continue;
      }
      if (a.to && l.date > a.to) break;
      running += delta;
      rows.push({ lineId: l.id, entryId: l.entryId, entryNumber: l.entryNumber, date: l.date, sourceType: l.sourceType, debit: l.debit, credit: l.credit, balance: running, ...(l.memo ? { memo: l.memo } : {}) });
    }
    return {
      account: { id: account.id, number: account.number, name: account.name, type: account.type, subtype: account.subtype },
      openingBalanceMinor: opening,
      closingBalanceMinor: running,
      rows,
    };
  },
});
