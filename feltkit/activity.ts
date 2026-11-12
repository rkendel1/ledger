/**
 * The audit trail, for people: every recorded financial event, newest first. Events are written in the
 * same transaction as the change they describe and are never edited by Ledger's code. Each carries the
 * actor (and whether it was an agent), the request id that links to FeltKit's activity log, and its data.
 */
import { s } from "@feltdb/feltkit";
import { app, audit } from "./app.js";
import { requireSettings } from "./_ledger.js";

export const list = app.query({
  access: "audit.read",
  args: {
    subjectType: s.optional(s.string()),
    subjectId: s.optional(s.string()),
    actorType: s.optional(s.string()),
    limit: s.optional(s.integer({ minimum: 1, maximum: 500 })),
  },
  handler: async (ctx, a) => {
    await requireSettings(ctx);
    const filter: Record<string, string> = {};
    if (a.subjectType) filter.subjectType = a.subjectType;
    if (a.subjectId) filter.subjectId = a.subjectId;
    if (a.actorType) filter.actorType = a.actorType;
    const rows = (await ctx.db.find(audit, filter as never)) as unknown as Array<{ id: string; at: number; seq: number; subjectType: string; subjectId: string; type: string; actor: string; actorType: string; requestId: string; data?: Record<string, unknown> }>;
    return rows.sort((x, y) => y.at - x.at || y.seq - x.seq).slice(0, a.limit ?? 200);
  },
});
