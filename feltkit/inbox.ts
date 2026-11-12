/**
 * The signed-in person's notifications (AppPort Services Notifications): bills awaiting approval and
 * similar notices. Each principal reads and marks only its own; the service enforces it.
 * Notifications belong to the person, not the organization: a person who belongs to several
 * organizations sees all of their own notices here (GAP-REGISTER.md, G-07).
 */
import { s } from "@feltdb/feltkit";
import { app } from "./app.js";

export const list = app.query({
  access: "notifications.read",
  args: { unread: s.optional(s.boolean()) },
  handler: async (ctx, { unread }) =>
    (await ctx.services.notifications.list(unread ? { unread: true } : {})).map((n) => ({ id: n.id, type: n.type, title: n.title, data: n.data ?? null, createdAt: n.createdAt, read: Boolean((n as { readAt?: string }).readAt) })),
});

export const markRead = app.mutation({
  access: "notifications.update",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    await ctx.services.notifications.markRead(id);
    return { ok: true };
  },
});
