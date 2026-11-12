import { AreaChart, BarChart, DonutChart, Sparkline } from "@stack-ui/react";
import { api, Badge, Card, Empty, fmt, fmtDate, Link, Loading, Money, monthsBack, Page, SOURCE_LABEL, useChartMoney, useQuery } from "../lib";

export function Overview() {
  const o = useQuery(api.overview.get, {});
  const queue = useQuery(api.review.queue, {});
  const from = o ? monthsBack(o.asOf, 11) : "";
  const trends = useQuery(api.reports.trends, o ? { from, to: o.asOf } : "skip");
  const pl = useQuery(api.reports.profitAndLoss, o ? { from: o.fiscalYearStart, to: o.asOf } : "skip");
  const money = useChartMoney();
  if (!o) return <Loading />;
  const months = trends?.months ?? [];
  const posted = months.some((m) => m.revenueMinor || m.expensesMinor || m.netCashFlowMinor);
  const sparkFor = (accountId: string) => trends?.cashAccounts.find((a) => a.accountId === accountId)?.balances ?? [];
  return (
    <Page title={o.organization} subtitle={`As of ${fmtDate(o.asOf)} · fiscal year from ${fmtDate(o.fiscalYearStart)}`}>
      <div className="kpis">
        <Kpi label="Cash" to="reports/balance" minor={o.cash.totalMinor} note={`${o.cash.accounts.length} account${o.cash.accounts.length === 1 ? "" : "s"}`} />
        <Kpi label="Receivable" to="reports/ar" minor={o.receivables.totalMinor} note={o.receivables.overdueMinor ? <><Money minor={o.receivables.overdueMinor} /> overdue</> : `${o.receivables.count} open`} warn={o.receivables.overdueMinor > 0} />
        <Kpi label="Payable" to="reports/ap" minor={o.payables.totalMinor} note={o.payables.overdueMinor ? <><Money minor={o.payables.overdueMinor} /> overdue</> : `${o.payables.count} open`} warn={o.payables.overdueMinor > 0} />
        <Kpi label="Revenue (YTD)" to="reports/pl" minor={o.yearToDate.revenueMinor} />
        <Kpi label="Expenses (YTD)" to="reports/pl" minor={o.yearToDate.expensesMinor} />
        <Kpi label="Net income (YTD)" to="reports/pl" minor={o.yearToDate.netIncomeMinor} />
      </div>
      <div className="grid2 charts">
        <Card>
          <BarChart
            title="Income and expenses by month"
            description={`Posted revenue and expenses, ${fmtDate(from)} – ${fmtDate(o.asOf)}`}
            format={money}
            loading={trends === undefined}
            emptyTitle="No income or expenses posted yet"
            emptyBody="Bars appear as invoices, bills and expenses are posted."
            series={posted ? [
              { id: "revenue", label: "Revenue", data: months.map((m) => ({ x: m.label, y: m.revenueMinor })) },
              { id: "expenses", label: "Expenses", data: months.map((m) => ({ x: m.label, y: m.expensesMinor })) },
            ] : []}
          />
        </Card>
        <Card>
          <AreaChart
            title="Net cash flow by month"
            description="Change in cash and bank accounts each month"
            format={money}
            loading={trends === undefined}
            emptyTitle="No cash movement yet"
            series={posted ? [{ id: "cash", label: "Net cash flow", data: months.map((m) => ({ x: m.label, y: m.netCashFlowMinor })) }] : []}
          />
        </Card>
        <Card>
          <DonutChart
            title="Expenses by category"
            description={`Fiscal year to date, from ${fmtDate(o.fiscalYearStart)}`}
            format={money}
            loading={pl === undefined}
            centerValue={pl ? fmt(pl.totalCostOfSalesMinor + pl.totalExpensesMinor, o.currency) : undefined}
            centerLabel="Total expenses"
            emptyTitle="No expenses posted this fiscal year"
            series={pl && pl.expenses.length + pl.costOfSales.length ? [{ id: "expenses", label: "Expenses", data: [...pl.costOfSales, ...pl.expenses].map((r) => ({ x: `${r.number} ${r.name}`, y: r.amountMinor })) }] : []}
          />
        </Card>
        <Card title="Needs attention" actions={<Link to="activity">All</Link>}>
          {queue === undefined ? <Loading /> : queue.length === 0 ? <Empty>Nothing needs attention.</Empty> : (
            <ul className="queue">
              {queue.slice(0, 8).map((i, k) => (
                <li key={k}>
                  <Badge tone={i.severity === "high" ? "bad" : i.severity === "medium" ? "warn" : "muted"}>{i.kind.replace(/_/g, " ")}</Badge>
                  <a className="link" href={linkFor(i.link)}>{i.title}</a>
                  <small>{i.detail}</small>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Bank accounts" actions={<Link to="banking">Banking</Link>}>
          {o.banks.length === 0 ? <Empty>No bank accounts yet. <Link to="banking">Add one</Link> to import statements.</Empty> : (
            <table className="t"><tbody>
              {o.banks.map((b) => (
                <tr key={b.id}>
                  <td><Link to={`banking/${b.id}`}>{b.name}</Link></td>
                  <td>{b.unmatchedCount ? <Badge tone="warn">{b.unmatchedCount} unmatched</Badge> : <Badge tone="ok">all matched</Badge>}</td>
                  <td className="muted">{b.lastReconciledThrough ? `Reconciled through ${fmtDate(b.lastReconciledThrough)}` : "Never reconciled"}</td>
                </tr>
              ))}
            </tbody></table>
          )}
          <h3>Cash by account</h3>
          <table className="t"><tbody>
            {o.cash.accounts.map((c) => (
              <tr key={c.accountId}>
                <td><Link to={`accounting/account/${c.accountId}`}>{c.number} · {c.name}</Link></td>
                <td>{trends ? <Sparkline label={`${c.name} month-end balance, last 12 months`} format={money} endpoints width={96} height={24} data={sparkFor(c.accountId).map((y, i) => ({ x: i, y }))} xType="number" /> : null}</td>
                <td className="num"><Money minor={c.balanceMinor} /></td>
              </tr>
            ))}
          </tbody></table>
        </Card>
        <Card title="Outstanding invoices" actions={<Link to="invoices">All invoices</Link>}>
          {o.outstandingInvoices.length === 0 ? <Empty>No open invoices.</Empty> : (
            <table className="t"><tbody>
              {o.outstandingInvoices.map((i) => <tr key={i.id}><td><Link to={`invoices/${i.id}`}>{i.number}</Link></td><td>{i.overdue ? <Badge tone="bad">overdue</Badge> : null} due {fmtDate(i.dueDate)}</td><td className="num"><Money minor={i.balanceMinor} /></td></tr>)}
            </tbody></table>
          )}
        </Card>
        <Card title="Bills due in 14 days" actions={<Link to="bills">All bills</Link>}>
          {o.upcomingBills.length === 0 ? <Empty>Nothing due soon.</Empty> : (
            <table className="t"><tbody>
              {o.upcomingBills.map((b) => <tr key={b.id}><td><Link to={`bills/${b.id}`}>{b.billNumber}</Link></td><td>{b.overdue ? <Badge tone="bad">overdue</Badge> : null} due {fmtDate(b.dueDate)}</td><td className="num"><Money minor={b.balanceMinor} /></td></tr>)}
            </tbody></table>
          )}
        </Card>
      </div>
      <Card title="Recent transactions" actions={<Link to="transactions">Journal</Link>}>
        {o.recent.length === 0 ? <Empty>No posted entries yet.</Empty> : (
          <table className="t"><thead><tr><th>#</th><th>Date</th><th>Description</th><th>Source</th><th className="num">Amount</th></tr></thead><tbody>
            {o.recent.map((e) => <tr key={e.id}><td><Link to={`transactions/${e.id}`}>{e.number}</Link></td><td>{fmtDate(e.date)}</td><td>{e.description}</td><td className="muted">{SOURCE_LABEL[e.sourceType]}</td><td className="num"><Money minor={e.totalMinor} /></td></tr>)}
          </tbody></table>
        )}
      </Card>
    </Page>
  );
}

function Kpi({ label, minor, to, note, warn }: { label: string; minor: number; to: string; note?: React.ReactNode; warn?: boolean }) {
  return (
    <a className={`kpi${warn ? " warn" : ""}`} href={`#/${to}`}>
      <span className="label">{label}</span>
      <span className="value"><Money minor={minor} /></span>
      {note ? <span className="note">{note}</span> : null}
    </a>
  );
}

export function linkFor(link: { type: string; id: string }) {
  const map: Record<string, string> = { proposal: "activity", bankTransaction: "banking", bankAccount: `banking/${link.id}`, journal: `transactions/${link.id}`, invoice: `invoices/${link.id}`, bill: `bills/${link.id}`, expense: `expenses/${link.id}` };
  return `#/${map[link.type] ?? "overview"}`;
}
