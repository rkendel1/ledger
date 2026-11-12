/**
 * Bank statement CSV parsing. Pure functions; no floating point touches an amount.
 *
 * Accepted layouts (header names are matched case-insensitively):
 *   Date, Description, Amount              (signed: negative = money out)
 *   Date, Description, Debit, Credit       (or Withdrawal / Deposit; either may be blank)
 * Optional: a Balance column is read and kept for discrepancy checks; a Payee or Memo column is
 * appended to the description. Date formats: YYYY-MM-DD, MM/DD/YYYY (default for slashes) or
 * DD/MM/YYYY when `dateFormat: "dmy"`.
 */

import { sha256Hex as feltkitSha256Hex } from "@feltdb/feltkit";
export interface ParsedRow {
  row: number;
  date: string;
  description: string;
  amountMinor: number;
  balanceMinor?: number;
}

export interface ParseResult {
  rows: ParsedRow[];
  rejected: Array<{ row: number; reason: string; raw: string }>;
  columns: string[];
}

/** RFC 4180 fields: commas, quotes, doubled quotes, CRLF. */
export function splitCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      out.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    out.push(row);
  }
  return out.filter((r) => r.some((f) => f.trim() !== ""));
}

/** "1,234.56", "-12", "(12.50)", "$3.4", "+7.00" → minor units. null when it is not an amount. */
export function parseAmount(raw: string): number | null {
  let s = raw.trim().replace(/[$€£\s]/g, "").replace(/,/g, "");
  if (s === "") return null;
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) return null;
  return negative ? -minor : minor;
}

export function parseDate(raw: string, format: "auto" | "ymd" | "mdy" | "dmy" = "auto"): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let r = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (r && (format === "auto" || format === "ymd")) {
    [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  } else {
    r = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
    if (!r || format === "ymd") return null;
    const a = Number(r[1]);
    const b = Number(r[2]);
    y = Number(r[3]!.length === 2 ? `20${r[3]}` : r[3]);
    [m, d] = format === "dmy" ? [b, a] : [a, b];
  }
  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

const HEADERS = {
  date: ["date", "transaction date", "posted date", "posting date", "value date"],
  description: ["description", "details", "narrative", "transaction description", "name"],
  extra: ["payee", "memo", "reference"],
  amount: ["amount", "transaction amount", "amount (usd)"],
  debit: ["debit", "withdrawal", "withdrawals", "money out", "paid out"],
  credit: ["credit", "deposit", "deposits", "money in", "paid in"],
  balance: ["balance", "running balance"],
};

export function parseStatement(text: string, dateFormat: "auto" | "ymd" | "mdy" | "dmy" = "auto"): ParseResult {
  const table = splitCsv(text.replace(/^﻿/, ""));
  if (table.length === 0) return { rows: [], rejected: [], columns: [] };
  const header = table[0]!.map((h) => h.trim().toLowerCase());
  const find = (names: string[]) => header.findIndex((h) => names.includes(h));
  const col = {
    date: find(HEADERS.date),
    description: find(HEADERS.description),
    extra: find(HEADERS.extra),
    amount: find(HEADERS.amount),
    debit: find(HEADERS.debit),
    credit: find(HEADERS.credit),
    balance: find(HEADERS.balance),
  };
  if (col.date < 0 || col.description < 0 || (col.amount < 0 && (col.debit < 0 || col.credit < 0))) {
    throw new Error(`The statement needs Date, Description and either Amount or Debit and Credit columns. Found: ${table[0]!.join(", ")}`);
  }
  const rows: ParsedRow[] = [];
  const rejected: ParseResult["rejected"] = [];
  table.slice(1).forEach((cells, i) => {
    const rowNo = i + 2;
    const raw = cells.join(",").slice(0, 300);
    const date = parseDate(cells[col.date] ?? "", dateFormat);
    if (!date) return rejected.push({ row: rowNo, reason: `Unreadable date "${cells[col.date] ?? ""}"`, raw });
    let description = (cells[col.description] ?? "").trim().replace(/\s+/g, " ");
    if (col.extra >= 0 && cells[col.extra]?.trim()) description = `${description} ${cells[col.extra]!.trim()}`.trim();
    if (!description) description = "(no description)";
    let amount: number | null;
    if (col.amount >= 0) amount = parseAmount(cells[col.amount] ?? "");
    else {
      const debit = (cells[col.debit] ?? "").trim() ? parseAmount(cells[col.debit]!) : 0;
      const credit = (cells[col.credit] ?? "").trim() ? parseAmount(cells[col.credit]!) : 0;
      amount = debit === null || credit === null ? null : Math.abs(credit) - Math.abs(debit);
    }
    if (amount === null) return rejected.push({ row: rowNo, reason: "Unreadable amount", raw });
    if (amount === 0) return rejected.push({ row: rowNo, reason: "Zero amount", raw });
    const balance = col.balance >= 0 ? parseAmount(cells[col.balance] ?? "") : null;
    rows.push({ row: rowNo, date, description: description.slice(0, 300), amountMinor: amount, ...(balance !== null ? { balanceMinor: balance } : {}) });
  });
  return { rows, rejected, columns: table[0]! };
}

/** Payee text for matching: lowercase, no reference numbers or punctuation, the first four words. */
export function normalizePayee(description: string): string {
  return description
    .toLowerCase()
    .replace(/\b(pos|ach|debit|credit|card|purchase|payment|online|transfer|ref|recurring|visa|mastercard)\b/g, " ")
    .replace(/[0-9]{3,}/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 4)
    .join(" ") || description.toLowerCase().trim();
}

/** SHA-256 of the statement text (FeltKit's, which runs the same on Node and in an AppBoundry artifact; Web Crypto does not exist in the latter). */
export async function sha256Hex(text: string): Promise<string> {
  return feltkitSha256Hex(text);
}
