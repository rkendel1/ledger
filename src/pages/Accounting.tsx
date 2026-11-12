import { useState } from "react";
import { LineChart } from "@stack-ui/react";
import { AccountSelect, api, Badge, Card, Empty, Field, fmtDate, fmtTime, Link, Loading, Modal, Money, MoneyInput, Page, parseMoney, SOURCE_LABEL, Tabs, useCan, useChartMoney, useMutation, useQuery, useRun } from "../lib";

const TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;
const SUBTYPES: Record<string, string[]> = {
  asset: ["cash", "bank", "other_current_asset", "fixed_asset"],
  liability: ["credit_card", "tax_payable", "other_current_liability", "long_term_liability"],
  equity: ["equity"],
  revenue: ["revenue", "other_income"],
  expense: ["cost_of_sales", "expense"],
};

export function Accounting({ path }: { path: string[] }) {
  if (path[0] === "account" && path[1]) return <AccountHistory id={path[1]} />;
  return <AccountingHome />;
}

function AccountingHome() {
  const [tab, setTab] = useState<"chart" | "periods" | "opening" | "tax">("chart");
  return (
    <Page title="Accounting" subtitle="The chart of accounts, closed periods and opening balances.">
      <Tabs value={tab} onChange={setTab} tabs={[["chart", "Chart of accounts"], ["periods", "Periods"], ["opening", "Opening balances"], ["tax", "Tax rates"]]} />
      {tab === "chart" ? <Chart /> : tab === "periods" ? <Periods /> : tab === "opening" ? <OpeningBalances /> : <TaxRates />}
    </Page>
  );
}

function Chart() {
  const accounts = useQuery(api.accounts.list, { includeInactive: true });
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const can = useCan();
  if (!accounts) return <Loading />;
  return (
    <Card title="Chart of accounts" actions={<span className="actions"><label className="check"><input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} /> Show debits & credits</label>{can("accounts.write") ? <button className="small" onClick={() => setEditing("new")}>Add account</button> : null}</span>}>
      {TYPES.map((type) => {
        const rows = accounts.filter((a) => a.type === type);
        return (
          <div key={type} className="chart-group">
            <h3>{type === "asset" ? "Assets" : type === "liability" ? "Liabilities" : type === "equity" ? "Equity" : type === "revenue" ? "Revenue" : "Expenses"}</h3>
            <table className="t">
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className={a.active ? "" : "muted"}>
                    <td className="mono">{a.number}</td>
                    <td><Link to={`accounting/account/${a.id}`}>{a.parentId ? "↳ " : ""}{a.name}</Link>{a.system ? <Badge tone="info">system</Badge> : null}{!a.active ? <Badge>inactive</Badge> : null}</td>
                    <td className="muted">{a.subtype.replace(/_/g, " ")}</td>
                    {advanced ? <><td className="num"><Money minor={a.debitMinor} muted /></td><td className="num"><Money minor={a.creditMinor} muted /></td></> : null}
                    <td className="num"><Money minor={a.balanceMinor} /></td>
                    <td className="num">{can("accounts.write") ? <button className="small" onClick={() => setEditing(a.id)}>Edit</button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      {editing ? <AccountForm account={editing === "new" ? undefined : accounts.find((a) => a.id === editing)} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

type Acc = NonNullable<ReturnType<typeof useQuery<typeof api.accounts.list>>>[number];

function AccountForm({ account, onClose }: { account?: Acc; onClose: () => void }) {
  const create = useMutation(api.accounts.create);
  const update = useMutation(api.accounts.update);
  const { run, busy } = useRun();
  const [number, setNumber] = useState(account?.number ?? "");
  const [name, setName] = useState(account?.name ?? "");
  const [type, setType] = useState<(typeof TYPES)[number]>(account?.type ?? "expense");
  const [subtype, setSubtype] = useState(account?.subtype ?? "expense");
  const [parentId, setParentId] = useState(account?.parentId ?? "");
  const [active, setActive] = useState(account?.active ?? true);
  return (
    <Modal title={account ? `Edit ${account.number} ${account.name}` : "New account"} onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        const r = account
          ? await run(() => update({ id: account.id, number, name, ...(account.system ? {} : { subtype: subtype as never }), parentId: parentId || null, active }), "Saved")
          : await run(() => create({ number, name, type, subtype: subtype as never, ...(parentId ? { parentId } : {}) }), "Account added");
        if (r) onClose();
      }}>
        <div className="row">
          <Field label="Number"><input required pattern="[0-9]{3,8}" value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
          <Field label="Name"><input required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        </div>
        <div className="row">
          <Field label="Type" hint={account ? "Fixed once created" : undefined}>
            <select disabled={!!account} value={type} onChange={(e) => { const t = e.target.value as (typeof TYPES)[number]; setType(t); setSubtype(SUBTYPES[t]![0]! as never); }}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          </Field>
          <Field label="Kind">
            <select disabled={account?.system} value={subtype} onChange={(e) => setSubtype(e.target.value as never)}>{(account?.system ? [subtype] : SUBTYPES[type]!).map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}</select>
          </Field>
        </div>
        <Field label="Parent account" hint="Optional, one level"><AccountSelect value={parentId} onChange={setParentId} types={[type]} placeholder="None" /></Field>
        {account && !account.system ? <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active</label> : null}
        <div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Save</button></div>
      </form>
    </Modal>
  );
}

function AccountHistory({ id }: { id: string }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const h = useQuery(api.accounts.history, { accountId: id, ...(from ? { from } : {}), ...(to ? { to } : {}) });
  const money = useChartMoney({ cents: true });
  if (!h) return <Loading />;
  // The running balance at the end of each day with activity (the last row of that day).
  const daily = new Map<string, number>();
  for (const r of h.rows) daily.set(r.date, r.balance);
  return (
    <Page title={`${h.account.number} · ${h.account.name}`} subtitle={`${h.account.type} · ${h.account.subtype.replace(/_/g, " ")} · every balance below is the running sum of posted lines`}>
      {h.rows.length ? (
        <Card>
          <LineChart
            title="Balance over time"
            description="End-of-day balance after each day with posted activity"
            xType="time" format={money} zeroBaseline={false} legend={false} curve="step"
            series={[{ id: "balance", label: "Balance", data: [...daily].map(([x, y]) => ({ x, y })) }]}
          />
        </Card>
      ) : null}
      <Card actions={<span className="actions"><Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></span>}>
        {h.rows.length === 0 ? <Empty>No posted lines in this range.</Empty> : (
          <table className="t">
            <thead><tr><th>Date</th><th>#</th><th>Source</th><th>Memo</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
            <tbody>
              {from ? <tr className="muted"><td colSpan={6}>Opening balance</td><td className="num"><Money minor={h.openingBalanceMinor} /></td></tr> : null}
              {h.rows.map((r) => <tr key={r.lineId}><td>{fmtDate(r.date)}</td><td><Link to={`transactions/${r.entryId}`}>{r.entryNumber}</Link></td><td className="muted">{SOURCE_LABEL[r.sourceType]}</td><td>{r.memo}</td><td className="num">{r.debit ? <Money minor={r.debit} /> : ""}</td><td className="num">{r.credit ? <Money minor={r.credit} /> : ""}</td><td className="num"><Money minor={r.balance} /></td></tr>)}
            </tbody>
            <tfoot><tr><td colSpan={6}>Closing balance</td><td className="num"><strong><Money minor={h.closingBalanceMinor} /></strong></td></tr></tfoot>
          </table>
        )}
      </Card>
    </Page>
  );
}

function Periods() {
  const settings = useQuery(api.org.settings, {});
  const history = useQuery(api.org.periodHistory, {});
  const close = useMutation(api.org.closePeriod);
  const reopen = useMutation(api.org.reopenPeriod);
  const can = useCan();
  const { run, busy } = useRun();
  const [through, setThrough] = useState("");
  if (!settings || !history) return <Loading />;
  return (
    <Card title={settings.closedThrough ? `Books closed through ${fmtDate(settings.closedThrough)}` : "No period is closed"}>
      <p className="muted">Closing protects a period: nothing dated on or before the date can be posted or reversed. Reopening needs a reason and is recorded.</p>
      {can("periods.close") ? (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => close({ through }), "Period closed"); }}>
          <Field label="Close through"><input type="date" required value={through} onChange={(e) => setThrough(e.target.value)} /></Field>
          <button className="primary" disabled={busy}>Close period</button>
          {settings.closedThrough && can("periods.reopen") ? <button type="button" onClick={() => {
            const reason = prompt("Why reopen? This is recorded.");
            if (!reason) return;
            const to = prompt("Move the boundary back to (YYYY-MM-DD, or empty to reopen everything)", "");
            if (to !== null) void run(() => reopen({ to, reason }), "Reopened");
          }}>Reopen…</button> : null}
        </form>
      ) : null}
      <h3>History</h3>
      {history.length === 0 ? <Empty>No closes yet.</Empty> : <ul className="history">{history.map((h) => <li key={h.id}><strong>{h.action}</strong> {h.closedThrough ? `through ${fmtDate(h.closedThrough)}` : "(all open)"} by {h.by} · {fmtTime(h.at)}{h.reason ? ` — ${h.reason}` : ""}</li>)}</ul>}
    </Card>
  );
}

function OpeningBalances() {
  const set = useMutation(api.accounts.setOpeningBalances);
  const can = useCan();
  const { run, busy } = useRun();
  const [date, setDate] = useState(() => { const d = new Date(); d.setUTCDate(0); return d.toISOString().slice(0, 10); });
  const [rows, setRows] = useState([{ accountId: "", amount: "" }]);
  const parsed = rows.map((r) => ({ ...r, minor: parseMoney(r.amount) }));
  const valid = parsed.every((r) => r.accountId && r.minor !== null);
  if (!can("journal.post")) return <Card><Empty>An accountant enters opening balances.</Empty></Card>;
  return (
    <Card title="Opening balances">
      <p className="muted">Balances on the day before your books start. Ledger posts one entry and puts the difference in Opening Balance Equity. Enter unpaid customer invoices and vendor bills as documents instead.</p>
      <Field label="As of"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      {rows.map((r, i) => (
        <div className="split" key={i}>
          <AccountSelect value={r.accountId} onChange={(v) => setRows(rows.map((x, k) => (k === i ? { ...x, accountId: v } : x)))} types={["asset", "liability", "equity"]} />
          <MoneyInput value={r.amount} onChange={(v) => setRows(rows.map((x, k) => (k === i ? { ...x, amount: v } : x)))} />
        </div>
      ))}
      <div className="split-foot">
        <button className="small" onClick={() => setRows([...rows, { accountId: "", amount: "" }])}>Add account</button>
        <button className="primary" disabled={!valid || busy} onClick={() => run(() => set({ date, balances: parsed.map((r) => ({ accountId: r.accountId, balanceMinor: r.minor! })), idempotencyKey: `ui-${crypto.randomUUID()}` }), "Opening balances posted")}>Post opening balances</button>
      </div>
    </Card>
  );
}

function TaxRates() {
  const rates = useQuery(api.invoices.listTaxRates, {});
  const create = useMutation(api.invoices.createTaxRate);
  const can = useCan();
  const { run, busy } = useRun();
  const [name, setName] = useState("");
  const [rate, setRate] = useState("");
  const [accountId, setAccountId] = useState("");
  if (!rates) return <Loading />;
  return (
    <Card title="Tax rates">
      {rates.length === 0 ? <Empty>No tax rates.</Empty> : <table className="t"><tbody>{rates.map((r) => <tr key={r.id}><td>{r.name}</td><td className="num">{(r.rateBp / 100).toFixed(2)}%</td></tr>)}</tbody></table>}
      {can("accounts.write") ? (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => create({ name, rateBp: Math.round(Number(rate) * 100), accountId }), "Tax rate added"); }}>
          <Field label="Name"><input required value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Rate (%)"><input required inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
          <Field label="Collected into"><AccountSelect value={accountId} onChange={setAccountId} subtypes={["tax_payable"]} /></Field>
          <button disabled={busy || !accountId}>Add</button>
        </form>
      ) : null}
    </Card>
  );
}

