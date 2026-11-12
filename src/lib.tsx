/**
 * Shared UI pieces. Money is formatted from integer minor units; nothing here does arithmetic on floats
 * that is sent back to the server except `parseMoney`, which parses text exactly.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery, useMutation } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";

// ── Formatting ─────────────────────────────────────────────────────────────────────────────

export const CurrencyContext = createContext("USD");

export function fmt(minor: number | undefined | null, currency = "USD", opts: { sign?: boolean } = {}) {
  if (minor === undefined || minor === null) return "—";
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const cents = String(abs % 100).padStart(2, "0");
  const sym = currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : `${currency} `;
  const sign = minor < 0 ? "−" : opts.sign && minor > 0 ? "+" : "";
  return `${sign}${sym}${whole}.${cents}`;
}

/** How charts write this organization's amounts: they arrive as integer minor units from the ledger. */
export function useChartMoney(options: { compact?: boolean; cents?: boolean } = {}) {
  const currency = useContext(CurrencyContext);
  return { style: "currency" as const, currency, divisor: 100, ...(options.cents ? {} : { maximumFractionDigits: 0 }), ...(options.compact ? { compact: true } : {}) };
}

/** The first day of the month `back` months before the month of `day`. */
export function monthsBack(day: string, back: number) {
  const d = new Date(`${day.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 10);
}

export function Money({ minor, sign, muted }: { minor: number | undefined | null; sign?: boolean; muted?: boolean }) {
  const currency = useContext(CurrencyContext);
  return <span className={`money${minor !== undefined && minor !== null && minor < 0 ? " neg" : ""}${muted ? " muted" : ""}`}>{fmt(minor, currency, { sign })}</span>;
}

/** "1,234.56" → 123456. Exact: parsed as text, never through a float. null when not an amount. */
export function parseMoney(text: string): number | null {
  const s = text.trim().replace(/[$,\s]/g, "");
  const m = /^(-)?(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  const v = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return m[1] ? -v : v;
}

export function minorToInput(minor: number) {
  return (minor / 100).toFixed(2);
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function monthStart(d = today()) {
  return `${d.slice(0, 7)}-01`;
}

export function yearStart(d = today()) {
  return `${d.slice(0, 4)}-01-01`;
}

export function fmtDate(iso: string | undefined | null) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function fmtTime(ms: number) {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export const SOURCE_LABEL: Record<string, string> = {
  manual: "Journal", opening_balance: "Opening balance", reversal: "Reversal", invoice: "Invoice", credit_note: "Credit note",
  payment_received: "Payment received", bill: "Bill", payment_made: "Payment made", expense: "Expense", bank: "Bank", proposal: "Approved proposal",
};

// ── Routing ────────────────────────────────────────────────────────────────────────────────

export function useRoute(): [string[], (path: string) => void] {
  const read = () => (window.location.hash.replace(/^#\/?/, "") || "overview").split("/");
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [route, (path: string) => { window.location.hash = `/${path}`; }];
}

export function go(path: string) {
  window.location.hash = `/${path}`;
}

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return <a href={`#/${to}`} className={className ?? "link"}>{children}</a>;
}

// ── Permissions ────────────────────────────────────────────────────────────────────────────

export const PermissionsContext = createContext<ReadonlySet<string>>(new Set());

/** UI-only convenience: hides controls the server would refuse anyway. The server decides. */
export function useCan() {
  const perms = useContext(PermissionsContext);
  return (p: string) => perms.has(p);
}

export function useMe() {
  return useQuery(api.org.me, {});
}

// ── Actions with error display ─────────────────────────────────────────────────────────────

type Toast = { id: number; kind: "ok" | "error"; text: string };
const ToastContext = createContext<(kind: Toast["kind"], text: string) => void>(() => {});

export function Toasts({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 9000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/** Wrap a server call: busy state, a success message, and the server's own error message on failure. */
export function useRun() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) toast("ok", ok);
      return r;
    } catch (e) {
      const err = e as { message?: string; code?: string };
      toast("error", err.message ?? String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { run, busy };
}

export { useMutation, useQuery, api };

// ── Layout primitives ──────────────────────────────────────────────────────────────────────

export function Page({ title, subtitle, actions, children }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{title}</h1>
          {subtitle ? <p className="sub">{subtitle}</p> : null}
        </div>
        {actions ? <div className="actions">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ""}`}>
      {title || actions ? <div className="card-head"><h2>{title}</h2>{actions}</div> : null}
      {children}
    </section>
  );
}

export function Loading() {
  return <div className="loading" aria-busy="true">Loading…</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Badge({ tone, children }: { tone?: "ok" | "warn" | "bad" | "info" | "muted"; children: ReactNode }) {
  return <span className={`badge ${tone ?? "muted"}`}>{children}</span>;
}

export const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "info" | "muted"> = {
  paid: "ok", posted: "info", approved: "ok", matched: "ok", completed: "ok", issued: "info",
  partially_paid: "warn", overdue: "bad", draft: "muted", unmatched: "warn", excluded: "muted",
  void: "muted", rejected: "muted", pending: "warn", in_progress: "warn",
};

export function Status({ value }: { value: string }) {
  return <Badge tone={STATUS_TONE[value] ?? "muted"}>{value.replace(/_/g, " ")}</Badge>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><h2>{title}</h2><button className="icon" onClick={onClose} aria-label="Close">×</button></div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Array<[T, string]> }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([v, label]) => <button key={v} role="tab" aria-selected={v === value} className={v === value ? "on" : ""} onClick={() => onChange(v)}>{label}</button>)}
    </div>
  );
}

/** Account picker filtered by type(s). */
export function AccountSelect({ value, onChange, types, subtypes, placeholder }: { value: string; onChange: (id: string) => void; types?: string[]; subtypes?: string[]; placeholder?: string }) {
  const accounts = useQuery(api.accounts.list, {});
  const list = (accounts ?? []).filter((a) => (!types || types.includes(a.type)) && (!subtypes || subtypes.includes(a.subtype)));
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder ?? "Choose an account"}</option>
      {list.map((a) => <option key={a.id} value={a.id}>{a.number} · {a.name}</option>)}
    </select>
  );
}

export function ContactSelect({ kind, value, onChange }: { kind: "customer" | "vendor"; value: string; onChange: (id: string) => void }) {
  const contacts = useQuery(api.contacts.list, { kind });
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose a {kind}</option>
      {(contacts ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}

export function MoneyInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const bad = value.trim() !== "" && parseMoney(value) === null;
  return <input inputMode="decimal" className={bad ? "invalid" : ""} value={value} placeholder={placeholder ?? "0.00"} onChange={(e) => onChange(e.target.value)} />;
}
