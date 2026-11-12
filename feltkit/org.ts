/**
 * The organization: setup with a starting chart of accounts, settings, and closing periods.
 */
import { fail, s } from "@feltdb/feltkit";
import { accounts, app, audit, journalEntries, orgSettings, periodEvents, taxRates, type AccountSubtype, type AccountType } from "./app.js";
import { actor, requireDate, requireSettings } from "./_ledger.js";

type Seed = [number: string, name: string, type: AccountType, subtype: AccountSubtype, system?: boolean];

/** A starting chart for a small services business. Every account can be renamed; system accounts cannot be deactivated. */
export const DEFAULT_CHART: Seed[] = [
  ["1000", "Cash on Hand", "asset", "cash"],
  ["1010", "Business Checking", "asset", "bank"],
  ["1100", "Accounts Receivable", "asset", "receivable", true],
  ["1300", "Prepaid Expenses", "asset", "other_current_asset"],
  ["1500", "Equipment", "asset", "fixed_asset"],
  ["2000", "Accounts Payable", "liability", "payable", true],
  ["2100", "Business Credit Card", "liability", "credit_card"],
  ["2200", "Sales Tax Payable", "liability", "tax_payable", true],
  ["2500", "Loans Payable", "liability", "long_term_liability"],
  ["3000", "Owner's Capital", "equity", "equity"],
  ["3100", "Owner's Draws", "equity", "equity"],
  ["3200", "Retained Earnings", "equity", "retained_earnings", true],
  ["3900", "Opening Balance Equity", "equity", "opening_balance", true],
  ["4000", "Service Revenue", "revenue", "revenue"],
  ["4100", "Product Sales", "revenue", "revenue"],
  ["4900", "Other Income", "revenue", "other_income"],
  ["5000", "Contractors", "expense", "cost_of_sales"],
  ["6000", "Advertising & Marketing", "expense", "expense"],
  ["6100", "Bank & Payment Fees", "expense", "expense"],
  ["6200", "Meals", "expense", "expense"],
  ["6300", "Office Supplies", "expense", "expense"],
  ["6400", "Professional Fees", "expense", "expense"],
  ["6500", "Rent", "expense", "expense"],
  ["6600", "Software & Subscriptions", "expense", "expense"],
  ["6700", "Travel", "expense", "expense"],
  ["6800", "Utilities & Phone", "expense", "expense"],
  ["6900", "Miscellaneous Expense", "expense", "expense"],
];

const settingsOut = s.object({
  id: s.string(),
  legalName: s.string(),
  displayName: s.string(),
  baseCurrency: s.string(),
  fiscalYearStartMonth: s.integer(),
  closedThrough: s.string(),
});

/** The organization's settings, or null before setup. */
export const settings = app.query({
  access: "org.read",
  handler: async (ctx) => {
    app.requireTenant(ctx);
    const [row] = await ctx.db.find(orgSettings, {});
    if (!row) return null;
    const { id, legalName, displayName, baseCurrency, fiscalYearStartMonth, closedThrough } = row;
    return { id, legalName, displayName, baseCurrency, fiscalYearStartMonth, closedThrough };
  },
});

/** Who I am in this organization: id, role, and the permissions the server grants. */
export const me = app.query({
  access: "authenticated",
  handler: async (ctx) => {
    const tenant = app.tenant(ctx);
    const principal = ctx.auth.requirePrincipal();
    return { id: principal.id, type: principal.type, tenant: tenant ? { id: tenant.id, name: tenant.name, role: tenant.role } : null, permissions: [...ctx.auth.permissions] };
  },
});

/** Set up the organization's books: settings and a starting chart of accounts. Once only. */
export const setup = app.mutation({
  access: "org.manage",
  args: {
    legalName: s.string({ minLength: 1, maxLength: 200 }),
    displayName: s.optional(s.string({ minLength: 1, maxLength: 120 })),
    baseCurrency: s.string({ pattern: "^[A-Z]{3}$" }),
    fiscalYearStartMonth: s.integer({ minimum: 1, maximum: 12 }),
    salesTaxRateBp: s.optional(s.integer({ minimum: 0, maximum: 10000 })),
  },
  returns: settingsOut,
  capability: { name: "org.setup", description: "Set up an organization's books with a starting chart of accounts." },
  handler: async (ctx, a) => {
    const tenant = app.requireTenant(ctx);
    const [existing] = await ctx.db.find(orgSettings, {});
    if (existing) fail("FAILED_PRECONDITION", "This organization is already set up.");
    const now = Date.now();
    const row = {
      legalName: a.legalName.trim(),
      displayName: (a.displayName ?? a.legalName).trim(),
      baseCurrency: a.baseCurrency,
      fiscalYearStartMonth: a.fiscalYearStartMonth,
      closedThrough: "",
      createdAt: now,
      createdBy: actor(ctx),
    };
    const id = await ctx.db.insert(orgSettings, row);
    let taxAccountId = "";
    for (const [number, name, type, subtype, system] of DEFAULT_CHART) {
      const accountId = await ctx.db.insert(accounts, { number, name, type, subtype, active: true, system: Boolean(system), createdAt: now });
      if (subtype === "tax_payable") taxAccountId = accountId;
    }
    if (a.salesTaxRateBp !== undefined && a.salesTaxRateBp > 0) {
      await ctx.db.insert(taxRates, { name: `Sales tax ${(a.salesTaxRateBp / 100).toFixed(2)}%`, rateBp: a.salesTaxRateBp, accountId: taxAccountId, active: true });
    }
    await audit.record(ctx, { subject: "org", id: tenant.id, type: "org.setup", data: { legalName: row.legalName, baseCurrency: row.baseCurrency, fiscalYearStartMonth: row.fiscalYearStartMonth, accounts: DEFAULT_CHART.length } });
    return { id, legalName: row.legalName, displayName: row.displayName, baseCurrency: row.baseCurrency, fiscalYearStartMonth: row.fiscalYearStartMonth, closedThrough: "" };
  },
});

/** Rename the organization's books or change its fiscal year start. The base currency is fixed once set up. */
export const update = app.mutation({
  access: "org.manage",
  args: {
    legalName: s.optional(s.string({ minLength: 1, maxLength: 200 })),
    displayName: s.optional(s.string({ minLength: 1, maxLength: 120 })),
    fiscalYearStartMonth: s.optional(s.integer({ minimum: 1, maximum: 12 })),
  },
  handler: async (ctx, a) => {
    const current = await requireSettings(ctx);
    const patch = {
      ...(a.legalName ? { legalName: a.legalName.trim() } : {}),
      ...(a.displayName ? { displayName: a.displayName.trim() } : {}),
      ...(a.fiscalYearStartMonth ? { fiscalYearStartMonth: a.fiscalYearStartMonth } : {}),
    };
    if (a.fiscalYearStartMonth && a.fiscalYearStartMonth !== current.fiscalYearStartMonth && (await ctx.db.count(journalEntries, { status: "posted" })) > 0) {
      fail("FAILED_PRECONDITION", "The fiscal year start cannot change once entries are posted.");
    }
    await ctx.db.patch(orgSettings, current.id, patch);
    await audit.record(ctx, { subject: "org", id: current.tenantId as string, type: "org.updated", data: { before: { legalName: current.legalName, displayName: current.displayName, fiscalYearStartMonth: current.fiscalYearStartMonth }, changes: patch } });
    return { ok: true };
  },
});

/**
 * Close the books through a date: no entry dated on or before it can be posted (or reversed into it).
 * A posting that commits concurrently with the close conflicts on the settings record and is retried
 * against the new boundary, so nothing slips into a closed period.
 */
export const closePeriod = app.mutation({
  access: "periods.close",
  approval: "required",
  args: { through: s.string(), reason: s.optional(s.string({ maxLength: 500 })) },
  returns: s.object({ closedThrough: s.string() }),
  capability: { name: "periods.close", description: "Close the books through a date. People only; agents may propose." },
  handler: async (ctx, a) => {
    const through = requireDate(a.through, "through");
    const current = await requireSettings(ctx);
    if (current.closedThrough && through <= current.closedThrough) fail("FAILED_PRECONDITION", `The books are already closed through ${current.closedThrough}. To move the boundary back, reopen.`);
    const drafts = (await ctx.db.find(journalEntries, { status: "draft" })).filter((d) => d.date <= through);
    if (drafts.length > 0) fail("FAILED_PRECONDITION", `${drafts.length} draft journal entr${drafts.length === 1 ? "y is" : "ies are"} dated in the period. Post or delete ${drafts.length === 1 ? "it" : "them"} first.`);
    await ctx.db.patch(orgSettings, current.id, { closedThrough: through });
    const by = actor(ctx);
    const eventId = await ctx.db.insert(periodEvents, { action: "close", closedThrough: through, previous: current.closedThrough, by, at: Date.now(), ...(a.reason ? { reason: a.reason } : {}) });
    await audit.record(ctx, { subject: "period", id: eventId, type: "period.closed", data: { through, previous: current.closedThrough, ...(a.reason ? { reason: a.reason } : {}) } });
    return { closedThrough: through };
  },
});

/** Move the closed boundary back. Requires a reason; the history keeps every close and reopen. */
export const reopenPeriod = app.mutation({
  access: "periods.reopen",
  approval: "required",
  args: { to: s.string(), reason: s.string({ minLength: 3, maxLength: 500 }) },
  handler: async (ctx, a) => {
    const to = a.to === "" ? "" : requireDate(a.to, "to");
    const current = await requireSettings(ctx);
    if (!current.closedThrough) fail("FAILED_PRECONDITION", "No period is closed.");
    if (to >= current.closedThrough) fail("INVALID_ARGUMENT", `Reopening moves the boundary back: choose a date before ${current.closedThrough} (or "" to reopen everything).`);
    await ctx.db.patch(orgSettings, current.id, { closedThrough: to });
    const eventId = await ctx.db.insert(periodEvents, { action: "reopen", closedThrough: to, previous: current.closedThrough, by: actor(ctx), at: Date.now(), reason: a.reason });
    await audit.record(ctx, { subject: "period", id: eventId, type: "period.reopened", data: { to, previous: current.closedThrough, reason: a.reason } });
    return { closedThrough: to };
  },
});

export const periodHistory = app.query({
  access: "periods.read",
  handler: async (ctx) => {
    app.requireTenant(ctx);
    return ctx.db.find(periodEvents, {}, { orderBy: [{ field: "at", direction: "desc" }] });
  },
});

/** Members of this organization and their roles (from FeltKit tenancy). */
export const members = app.query({
  access: "org.read",
  handler: async (ctx) => {
    app.requireTenant(ctx);
    return (await ctx.tenancy.members()).map((m) => ({ principalId: m.principalId, role: m.role, displayName: (m as { displayName?: string }).displayName ?? m.principalId }));
  },
});
