import { useState } from "react";
import { api, Badge, Card, Empty, Field, fmtDate, Link, Loading, Money, monthStart, Page, Tabs, today, useQuery, yearStart } from "../lib";

type Tab = "pl" | "balance" | "cashflow" | "tb" | "gl" | "ar" | "ap" | "explain";

export function Reports({ path }: { path: string[] }) {
  const tab = (path[0] as Tab) || "pl";
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());
  const setTab = (t: Tab) => { window.location.hash = `/reports/${t}`; };
  const ranged = ["pl", "cashflow", "gl", "explain"].includes(tab);
  return (
    <Page title="Reports" subtitle="Computed from posted entries each time you open them. Click an account to see the entries behind it.">
      <Tabs value={tab} onChange={setTab} tabs={[["pl", "Profit & loss"], ["balance", "Balance sheet"], ["cashflow", "Cash flow"], ["tb", "Trial balance"], ["gl", "General ledger"], ["ar", "AR aging"], ["ap", "AP aging"], ["explain", "What changed"]]} />
      <div className="range">
        {ranged ? <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field> : null}
        <Field label={ranged ? "To" : "As of"}><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        {ranged ? <span className="quick"><button className="small" onClick={() => { setFrom(monthStart()); setTo(today()); }}>This month</button><button className="small" onClick={() => { setFrom(yearStart()); setTo(today()); }}>Year to date</button></span> : null}
      </div>
      {tab === "pl" ? <PL from={from} to={to} /> : null}
      {tab === "balance" ? <Balance asOf={to} /> : null}
      {tab === "cashflow" ? <CashFlow from={from} to={to} /> : null}
      {tab === "tb" ? <TB asOf={to} /> : null}
      {tab === "gl" ? <GL from={from} to={to} /> : null}
      {tab === "ar" ? <Aging kind="ar" asOf={to} /> : null}
      {tab === "ap" ? <Aging kind="ap" asOf={to} /> : null}
      {tab === "explain" ? <Explain from={from} to={to} /> : null}
    </Page>
  );
}

type Row = { accountId: string; number: string; name: string; amountMinor: number };

function Section({ title, rows, total }: { title: string; rows: Row[]; total: number }) {
  return (
    <>
      <tr className="section"><td colSpan={2}>{title}</td></tr>
      {rows.map((r) => <tr key={r.accountId}><td><Link to={`accounting/account/${r.accountId}`}>{r.number} · {r.name}</Link></td><td className="num"><Money minor={r.amountMinor} /></td></tr>)}
      <tr className="subtotal"><td>Total {title.toLowerCase()}</td><td className="num"><Money minor={total} /></td></tr>
    </>
  );
}

function PL({ from, to }: { from: string; to: string }) {
  const r = useQuery(api.reports.profitAndLoss, from <= to ? { from, to } : "skip");
  if (!r) return <Loading />;
  return (
    <Card title={`Profit and loss · ${fmtDate(from)} – ${fmtDate(to)}`}>
      <table className="t report"><tbody>
        <Section title="Revenue" rows={r.revenue} total={r.totalRevenueMinor} />
        {r.costOfSales.length ? <Section title="Cost of sales" rows={r.costOfSales} total={r.totalCostOfSalesMinor} /> : null}
        <tr className="total"><td>Gross profit</td><td className="num"><Money minor={r.grossProfitMinor} /></td></tr>
        {r.otherIncome.length ? <Section title="Other income" rows={r.otherIncome} total={r.totalOtherIncomeMinor} /> : null}
        <Section title="Expenses" rows={r.expenses} total={r.totalExpensesMinor} />
        <tr className="total"><td>Net income</td><td className="num"><Money minor={r.netIncomeMinor} /></td></tr>
      </tbody></table>
    </Card>
  );
}

function Balance({ asOf }: { asOf: string }) {
  const r = useQuery(api.reports.balanceSheet, { asOf });
  if (!r) return <Loading />;
  return (
    <Card title={`Balance sheet · ${fmtDate(asOf)}`} actions={r.balanced ? <Badge tone="ok">balances</Badge> : <Badge tone="bad">does not balance</Badge>}>
      <table className="t report"><tbody>
        <Section title="Assets" rows={r.assets} total={r.totalAssetsMinor} />
        <Section title="Liabilities" rows={r.liabilities} total={r.totalLiabilitiesMinor} />
        <tr className="section"><td colSpan={2}>Equity</td></tr>
        {r.equity.map((x) => <tr key={x.accountId}><td><Link to={`accounting/account/${x.accountId}`}>{x.number} · {x.name}</Link></td><td className="num"><Money minor={x.amountMinor} /></td></tr>)}
        <tr><td>Retained earnings (prior years)</td><td className="num"><Money minor={r.retainedEarningsPriorYearsMinor} /></td></tr>
        <tr><td>Current year earnings (since {fmtDate(r.fiscalYearStart)})</td><td className="num"><Money minor={r.currentYearEarningsMinor} /></td></tr>
        <tr className="subtotal"><td>Total equity</td><td className="num"><Money minor={r.totalEquityMinor} /></td></tr>
        <tr className="total"><td>Liabilities and equity</td><td className="num"><Money minor={r.totalLiabilitiesAndEquityMinor} /></td></tr>
      </tbody></table>
    </Card>
  );
}

function CashFlow({ from, to }: { from: string; to: string }) {
  const r = useQuery(api.reports.cashFlow, from <= to ? { from, to } : "skip");
  if (!r) return <Loading />;
  return (
    <Card title={`Cash flow · ${fmtDate(from)} – ${fmtDate(to)}`} actions={r.reconciles ? <Badge tone="ok">ties to cash</Badge> : <Badge tone="bad">does not tie to cash</Badge>}>
      <table className="t report"><tbody>
        <tr className="section"><td colSpan={2}>Operating activities</td></tr>
        <tr><td>Net income</td><td className="num"><Money minor={r.netIncomeMinor} /></td></tr>
        {r.operatingAdjustments.map((x) => <tr key={x.accountId}><td><Link to={`accounting/account/${x.accountId}`}>Change in {x.name}</Link></td><td className="num"><Money minor={x.amountMinor} /></td></tr>)}
        <tr className="subtotal"><td>Net cash from operating activities</td><td className="num"><Money minor={r.operatingMinor} /></td></tr>
        <Section title="Investing activities" rows={r.investing} total={r.investingMinor} />
        <Section title="Financing activities" rows={r.financing} total={r.financingMinor} />
        <tr className="total"><td>Net change in cash</td><td className="num"><Money minor={r.netChangeMinor} /></td></tr>
        <tr><td>Cash at start</td><td className="num"><Money minor={r.openingCashMinor} /></td></tr>
        <tr><td>Cash at end</td><td className="num"><Money minor={r.closingCashMinor} /></td></tr>
      </tbody></table>
    </Card>
  );
}

function TB({ asOf }: { asOf: string }) {
  const r = useQuery(api.reports.trialBalance, { asOf });
  if (!r) return <Loading />;
  return (
    <Card title={`Trial balance · ${fmtDate(asOf)}`} actions={r.balanced ? <Badge tone="ok">debits = credits</Badge> : <Badge tone="bad">out of balance</Badge>}>
      <table className="t report">
        <thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
        <tbody>{r.rows.map((x) => <tr key={x.accountId}><td><Link to={`accounting/account/${x.accountId}`}>{x.number} · {x.name}</Link></td><td className="num">{x.debitMinor ? <Money minor={x.debitMinor} /> : ""}</td><td className="num">{x.creditMinor ? <Money minor={x.creditMinor} /> : ""}</td></tr>)}</tbody>
        <tfoot><tr className="total"><td>Total</td><td className="num"><Money minor={r.totalDebitMinor} /></td><td className="num"><Money minor={r.totalCreditMinor} /></td></tr></tfoot>
      </table>
    </Card>
  );
}

function GL({ from, to }: { from: string; to: string }) {
  const r = useQuery(api.reports.generalLedger, from <= to ? { from, to } : "skip");
  if (!r) return <Loading />;
  if (r.accounts.length === 0) return <Card><Empty>No activity in this range.</Empty></Card>;
  return (
    <>
      {r.accounts.map((a) => (
        <Card key={a.accountId} title={<Link to={`accounting/account/${a.accountId}`}>{a.number} · {a.name}</Link>}>
          <table className="t">
            <thead><tr><th>Date</th><th>#</th><th>Memo</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
            <tbody>
              <tr className="muted"><td colSpan={5}>Opening</td><td className="num"><Money minor={a.openingMinor} /></td></tr>
              {a.rows.map((x) => <tr key={x.lineId}><td>{fmtDate(x.date)}</td><td><Link to={`transactions/${x.entryId}`}>{x.entryNumber}</Link></td><td>{x.memo}</td><td className="num">{x.debit ? <Money minor={x.debit} /> : ""}</td><td className="num">{x.credit ? <Money minor={x.credit} /> : ""}</td><td className="num"><Money minor={x.balance} /></td></tr>)}
            </tbody>
          </table>
        </Card>
      ))}
    </>
  );
}

function Aging({ kind, asOf }: { kind: "ar" | "ap"; asOf: string }) {
  const r = useQuery(kind === "ar" ? api.reports.arAging : api.reports.apAging, { asOf });
  if (!r) return <Loading />;
  const doc = kind === "ar" ? "invoices" : "bills";
  return (
    <Card title={`${kind === "ar" ? "Receivables" : "Payables"} aging · ${fmtDate(asOf)}`}>
      {r.items.length === 0 ? <Empty>Nothing outstanding.</Empty> : (
        <>
          <table className="t report">
            <thead><tr><th>{kind === "ar" ? "Customer" : "Vendor"}</th>{r.buckets.map((b) => <th key={b} className="num">{b === "current" ? "Current" : `${b} days`}</th>)}<th className="num">Total</th></tr></thead>
            <tbody>{r.contacts.map((c) => <tr key={c.contactId}><td>{c.name}</td>{r.buckets.map((b) => <td key={b} className="num">{(c as unknown as Record<string, number>)[b] ? <Money minor={(c as unknown as Record<string, number>)[b]} /> : ""}</td>)}<td className="num"><Money minor={c.total} /></td></tr>)}</tbody>
            <tfoot><tr className="total"><td>Total</td>{r.buckets.map((b) => <td key={b} className="num"><Money minor={r.totals[b]} /></td>)}<td className="num"><Money minor={r.totalMinor} /></td></tr></tfoot>
          </table>
          <h3>Open {doc}</h3>
          <table className="t"><tbody>{r.items.map((i) => <tr key={i.id}><td><Link to={`${doc}/${i.id}`}>{i.label}</Link></td><td>{i.contactName}</td><td>due {fmtDate(i.dueDate)}</td><td><Badge tone={i.bucket === "current" ? "muted" : "bad"}>{i.bucket}</Badge></td><td className="num"><Money minor={i.balanceMinor} /></td></tr>)}</tbody></table>
        </>
      )}
    </Card>
  );
}

function shiftBack(from: string, to: string) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  const end = new Date(Date.parse(from) - 86_400_000);
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function Explain({ from, to }: { from: string; to: string }) {
  const prev = shiftBack(from, to);
  const r = useQuery(api.reports.explainChange, from <= to ? { fromA: prev.from, toA: prev.to, fromB: from, toB: to } : "skip");
  if (!r) return <Loading />;
  return (
    <Card title={`What changed: ${fmtDate(from)} – ${fmtDate(to)} vs. ${fmtDate(prev.from)} – ${fmtDate(prev.to)}`}>
      <p className="lead">Net income went from <Money minor={r.netIncomeAMinor} /> to <Money minor={r.netIncomeBMinor} /> (<Money minor={r.netIncomeChangeMinor} sign />). {r.summary}.</p>
      {r.changes.length === 0 ? <Empty>No revenue or expense account changed.</Empty> : (
        <table className="t">
          <thead><tr><th>Account</th><th className="num">Before</th><th className="num">Now</th><th className="num">Change</th><th>Largest entries now</th></tr></thead>
          <tbody>{r.changes.map((c) => <tr key={c.accountId}><td><Link to={`accounting/account/${c.accountId}`}>{c.number} · {c.name}</Link></td><td className="num"><Money minor={c.periodAMinor} /></td><td className="num"><Money minor={c.periodBMinor} /></td><td className="num"><Money minor={c.changeMinor} sign /></td><td>{c.largestEntriesInB.map((e) => <Link key={e.entryId + e.amountMinor} to={`transactions/${e.entryId}`}>#{e.entryNumber} </Link>)}</td></tr>)}</tbody>
        </table>
      )}
      <p className="muted small">Computed by comparing posted entries; no model is involved.</p>
    </Card>
  );
}
