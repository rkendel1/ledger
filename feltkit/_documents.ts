/**
 * Derived document state. An invoice's or bill's paid amount, balance, and "paid / partially paid /
 * overdue" status are never stored: they are computed from allocations and dates, so they cannot
 * drift from the payments and credit notes that cause them.
 */
import type { MutationCtx, QueryCtx } from "@feltdb/feltkit";
import { allocations, bills, invoices } from "./app.js";

type Ctx = QueryCtx | MutationCtx;

export type InvoiceStatus = "draft" | "issued" | "partially_paid" | "paid" | "overdue" | "void";
export type BillStatus = "draft" | "approved" | "posted" | "partially_paid" | "paid" | "overdue" | "void";

/** Allocated amount per document, counting allocations dated on or before `asOf` (all when omitted). */
export async function allocatedByDocument(ctx: Ctx, documentType: "invoice" | "bill", asOf?: string) {
  const rows = await ctx.db.find(allocations, { documentType });
  const out = new Map<string, { paid: number; credited: number }>();
  for (const r of rows) {
    if (asOf && r.date > asOf) continue;
    const t = out.get(r.documentId) ?? { paid: 0, credited: 0 };
    if (r.sourceType === "payment") t.paid += r.amountMinor;
    else t.credited += r.amountMinor;
    out.set(r.documentId, t);
  }
  return out;
}

/** Allocated amount for one document (fenced read: concurrent allocations to it conflict). */
export async function allocatedTo(ctx: Ctx, documentId: string) {
  const rows = await ctx.db.find(allocations, { documentId });
  return rows.reduce((t, r) => t + r.amountMinor, 0);
}

export function invoiceState(inv: { status: string; totalMinor: number; dueDate: string }, alloc: { paid: number; credited: number } | undefined, asOf: string) {
  const paid = alloc?.paid ?? 0;
  const credited = alloc?.credited ?? 0;
  const balance = inv.status === "issued" ? inv.totalMinor - paid - credited : 0;
  let status: InvoiceStatus = inv.status as InvoiceStatus;
  if (inv.status === "issued") {
    if (balance <= 0) status = "paid";
    else if (inv.dueDate < asOf) status = "overdue";
    else if (paid + credited > 0) status = "partially_paid";
  }
  return { paidMinor: paid, creditedMinor: credited, balanceMinor: balance, derivedStatus: status };
}

export function billState(bill: { status: string; totalMinor: number; dueDate: string }, alloc: { paid: number } | undefined, asOf: string) {
  const paid = alloc?.paid ?? 0;
  const balance = bill.status === "posted" ? bill.totalMinor - paid : 0;
  let status: BillStatus = bill.status as BillStatus;
  if (bill.status === "posted") {
    if (balance <= 0) status = "paid";
    else if (bill.dueDate < asOf) status = "overdue";
    else if (paid > 0) status = "partially_paid";
  }
  return { paidMinor: paid, balanceMinor: balance, derivedStatus: status };
}

export async function openInvoices(ctx: Ctx, asOf: string) {
  const alloc = await allocatedByDocument(ctx, "invoice", asOf);
  return (await ctx.db.find(invoices, { status: "issued" }))
    .filter((i) => i.issueDate <= asOf)
    .map((i) => ({ ...i, ...invoiceState(i, alloc.get(i.id), asOf) }))
    .filter((i) => i.balanceMinor > 0);
}

export async function openBills(ctx: Ctx, asOf: string) {
  const alloc = await allocatedByDocument(ctx, "bill", asOf);
  return (await ctx.db.find(bills, { status: "posted" }))
    .filter((b) => b.billDate <= asOf)
    .map((b) => ({ ...b, ...billState(b, alloc.get(b.id), asOf) }))
    .filter((b) => b.balanceMinor > 0);
}

/** Aging buckets by days past due. */
export function bucket(dueDate: string, asOf: string): "current" | "1-30" | "31-60" | "61-90" | "90+" {
  const days = Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000);
  if (days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}
