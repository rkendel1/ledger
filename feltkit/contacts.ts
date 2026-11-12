/**
 * Customers and vendors.
 */
import { fail, s } from "@feltdb/feltkit";
import { accounts, app, audit, contacts } from "./app.js";
import { requireSettings } from "./_ledger.js";

const fields = {
  name: s.string({ minLength: 1, maxLength: 200 }),
  email: s.optional(s.string({ maxLength: 200, pattern: "^[^@\\s]+@[^@\\s]+$" })),
  phone: s.optional(s.string({ maxLength: 50 })),
  address: s.optional(s.string({ maxLength: 500 })),
  defaultAccountId: s.optional(s.string()),
  paymentTermsDays: s.optional(s.integer({ minimum: 0, maximum: 365 })),
};

export const list = app.query({
  access: "contacts.read",
  args: { kind: s.optional(s.enum(["customer", "vendor"] as const)), includeInactive: s.optional(s.boolean()) },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    return (await ctx.db.find(contacts, a.kind ? { kind: a.kind } : {}))
      .filter((c) => a.includeInactive || c.active)
      .sort((x, y) => x.name.localeCompare(y.name));
  },
});

export const get = app.query({
  access: "contacts.read",
  args: { id: s.string() },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    return ctx.db.get(contacts, a.id);
  },
});

export const create = app.mutation({
  access: "contacts.write",
  args: { kind: s.enum(["customer", "vendor"] as const), ...fields },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const name = a.name.trim();
    const [dup] = await ctx.db.find(contacts, { kind: a.kind, name });
    if (dup) fail("CONFLICT", `A ${a.kind} named ${name} already exists.`);
    if (a.defaultAccountId) {
      const acc = await ctx.db.get(accounts, a.defaultAccountId);
      if (!acc) fail("INVALID_ARGUMENT", "Unknown default account.");
    }
    const id = await ctx.db.insert(contacts, {
      kind: a.kind, name, paymentTermsDays: a.paymentTermsDays ?? 30, active: true, createdAt: Date.now(),
      ...(a.email ? { email: a.email } : {}), ...(a.phone ? { phone: a.phone } : {}), ...(a.address ? { address: a.address } : {}),
      ...(a.defaultAccountId ? { defaultAccountId: a.defaultAccountId } : {}),
    });
    await audit.record(ctx, { subject: "contact", id, type: "contact.created", data: { kind: a.kind, name } });
    return id;
  },
});

export const update = app.mutation({
  access: "contacts.write",
  args: { id: s.string(), ...fields, name: s.optional(s.string({ minLength: 1, maxLength: 200 })), active: s.optional(s.boolean()) },
  handler: async (ctx, a) => {
    const c = await ctx.db.get(contacts, a.id);
    if (!c) fail("NOT_FOUND", "No such contact.");
    if (a.name && a.name.trim() !== c.name) {
      const [dup] = await ctx.db.find(contacts, { kind: c.kind, name: a.name.trim() });
      if (dup) fail("CONFLICT", `A ${c.kind} named ${a.name.trim()} already exists.`);
    }
    if (a.defaultAccountId && !(await ctx.db.get(accounts, a.defaultAccountId))) fail("INVALID_ARGUMENT", "Unknown default account.");
    const { id, ...rest } = a;
    const patch = Object.fromEntries(Object.entries({ ...rest, ...(a.name ? { name: a.name.trim() } : {}) }).filter(([, v]) => v !== undefined));
    await ctx.db.patch(contacts, id, patch);
    await audit.record(ctx, { subject: "contact", id, type: "contact.updated", data: { changes: patch } });
    return { ok: true };
  },
});
