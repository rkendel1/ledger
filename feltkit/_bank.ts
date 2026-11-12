import { fail, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { accounts, bankAccounts } from "./app.js";

type Ctx = QueryCtx | MutationCtx;

export async function requireBankAccount(ctx: Ctx, id: string) {
  const ba = await ctx.db.get(bankAccounts, id);
  if (!ba) fail("NOT_FOUND", "No such bank account.");
  const ledger = await ctx.db.get(accounts, ba.accountId);
  if (!ledger) fail("FAILED_PRECONDITION", "The bank account's ledger account is missing.");
  return { ...ba, ledger };
}
