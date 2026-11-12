/**
 * Integrity: recompute the ledger's invariants from the stored records and report every violation.
 * Used by the test suite after every scenario, and by Settings → Integrity in the app.
 */
import { report } from "./_contracts.js";
import type { QueryCtx } from "@feltdb/feltkit";
import { app, accounts, journalEntries, ledgerLines } from "./app.js";
import { normalBalance, requireSettings } from "./_ledger.js";
import { openBills, openInvoices } from "./_documents.js";

export const check = app.query({
  access: "reports.read",
  returns: report<Awaited<ReturnType<typeof integrityData>>>(),
  capability: { name: "ledger.integrity", description: "Recompute the ledger's invariants and list any violation." },
  handler: (ctx) => integrityData(ctx),
});

export async function integrityData(ctx: QueryCtx) {
    await requireSettings(ctx);
    const problems: string[] = [];
    const entries = await ctx.db.find(journalEntries, {});
    const lines = await ctx.db.find(ledgerLines, {});
    const accountIds = new Set((await ctx.db.find(accounts, {})).map((a) => a.id));
    const byEntry = new Map<string, typeof lines>();
    for (const l of lines) byEntry.set(l.entryId, [...(byEntry.get(l.entryId) ?? []), l]);
    const posted = entries.filter((e) => e.status === "posted");
    const byId = new Map(entries.map((e) => [e.id, e]));

    for (const e of entries) {
      const ls = byEntry.get(e.id) ?? [];
      if (e.status === "draft") {
        if (ls.length) problems.push(`Draft ${e.id} has ${ls.length} ledger lines.`);
        continue;
      }
      if (ls.length < 2) problems.push(`Entry #${e.number} has ${ls.length} lines.`);
      const d = ls.reduce((t, l) => t + l.debit, 0);
      const c = ls.reduce((t, l) => t + l.credit, 0);
      if (d !== c) problems.push(`Entry #${e.number} does not balance: ${d} ≠ ${c}.`);
      if (d !== e.totalMinor) problems.push(`Entry #${e.number} total ${e.totalMinor} ≠ its lines ${d}.`);
      for (const l of ls) {
        if (l.date !== e.date) problems.push(`Entry #${e.number} line ${l.lineNo} is dated ${l.date}, the entry ${e.date}.`);
        if (l.entryNumber !== e.number) problems.push(`Entry #${e.number} line ${l.lineNo} carries number ${l.entryNumber}.`);
        if (!accountIds.has(l.accountId)) problems.push(`Entry #${e.number} line ${l.lineNo} names an unknown account.`);
        if ((l.debit > 0) === (l.credit > 0)) problems.push(`Entry #${e.number} line ${l.lineNo} is not one-sided.`);
      }
      if (e.reversalOf) {
        const original = byId.get(e.reversalOf);
        if (!original) problems.push(`Entry #${e.number} reverses a missing entry.`);
        else {
          const key = (l: { accountId: string; debit: number; credit: number }) => `${l.accountId}:${l.debit}:${l.credit}`;
          const mirror = (byEntry.get(original.id) ?? []).map((l) => key({ accountId: l.accountId, debit: l.credit, credit: l.debit })).sort();
          if (JSON.stringify(mirror) !== JSON.stringify(ls.map(key).sort())) problems.push(`Entry #${e.number} does not mirror entry #${original.number}.`);
        }
      }
    }
    for (const id of byEntry.keys()) if (!byId.has(id)) problems.push(`Ledger lines for a missing entry ${id}.`);
    const numbers = posted.map((e) => e.number).sort((x, y) => x - y);
    numbers.forEach((n, i) => {
      if (n !== i + 1) problems.push(`Journal numbering is not gapless at position ${i + 1} (found #${n}).`);
    });
    // Subledgers: the receivable and payable control accounts equal their open documents.
    const all = await ctx.db.find(accounts, {});
    const control = (subtype: string) => {
      const acc = all.find((a) => a.subtype === subtype && a.system);
      return acc ? lines.filter((l) => l.accountId === acc.id).reduce((t, l) => t + normalBalance(acc.type, l.debit, l.credit), 0) : 0;
    };
    const far = "9999-12-31";
    const arOpen = (await openInvoices(ctx, far)).reduce((t, i) => t + i.balanceMinor, 0);
    const apOpen = (await openBills(ctx, far)).reduce((t, b) => t + b.balanceMinor, 0);
    if (control("receivable") !== arOpen) problems.push(`Accounts Receivable ${control("receivable")} ≠ open invoices ${arOpen}.`);
    if (control("payable") !== apOpen) problems.push(`Accounts Payable ${control("payable")} ≠ open bills ${apOpen}.`);
    const debits = lines.reduce((t, l) => t + l.debit, 0);
    const credits = lines.reduce((t, l) => t + l.credit, 0);
    if (debits !== credits) problems.push(`Trial balance is out by ${debits - credits}.`);
    return { ok: problems.length === 0, problems: [...new Set(problems)].slice(0, 200), postedEntries: posted.length, drafts: entries.length - posted.length, lines: lines.length, debitsMinor: debits, creditsMinor: credits };
}
