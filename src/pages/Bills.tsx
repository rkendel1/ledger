import { useState } from "react";
import { AccountSelect, api, Card, ContactSelect, Empty, Field, fmtDate, fmtTime, Link, Loading, Money, MoneyInput, Page, parseMoney, Status, Tabs, today, useCan, useMutation, useQuery, useRun } from "../lib";
import { ContactForm, ContactsPanel } from "./Contacts";
import { PaymentForm } from "./Invoices";
import { Receipts } from "./Expenses";

export function Bills({ path }: { path: string[] }) {
  if (path[0] === "new") return <BillEditor />;
  if (path[0] === "vendors") return <Page title="Vendors"><ContactsPanel kind="vendor" /></Page>;
  if (path[0]) return <BillView id={path[0]} />;
  return <BillList />;
}

function BillList() {
  const bills = useQuery(api.bills.list, {});
  const [filter, setFilter] = useState<"todo" | "open" | "paid" | "all">("todo");
  const can = useCan();
  const rows = (bills ?? []).filter((b) => filter === "all" || (filter === "todo" ? ["draft", "approved"].includes(b.status) : filter === "open" ? ["posted", "partially_paid", "overdue"].includes(b.derivedStatus) : b.derivedStatus === "paid"));
  return (
    <Page title="Bills" subtitle="Captured → approved → posted to payables → paid." actions={<span className="actions"><a className="button" href="#/bills/vendors">Vendors</a>{can("bills.write") ? <a className="button primary" href="#/bills/new">New bill</a> : null}</span>}>
      <Tabs value={filter} onChange={setFilter} tabs={[["todo", "To approve / post"], ["open", "Unpaid"], ["paid", "Paid"], ["all", "All"]]} />
      <Card>
        {!bills ? <Loading /> : rows.length === 0 ? <Empty>No bills here.</Empty> : (
          <table className="t">
            <thead><tr><th>Vendor</th><th>Bill #</th><th>Date</th><th>Due</th><th>Status</th><th className="num">Total</th><th className="num">Balance</th></tr></thead>
            <tbody>{rows.map((b) => <tr key={b.id}><td>{b.vendorName}</td><td><Link to={`bills/${b.id}`}>{b.billNumber}</Link></td><td>{fmtDate(b.billDate)}</td><td>{fmtDate(b.dueDate)}</td><td><Status value={b.derivedStatus} /></td><td className="num"><Money minor={b.totalMinor} /></td><td className="num"><Money minor={b.balanceMinor} /></td></tr>)}</tbody>
          </table>
        )}
      </Card>
    </Page>
  );
}

function BillEditor() {
  const create = useMutation(api.bills.create);
  const vendors = useQuery(api.contacts.list, { kind: "vendor" });
  const { run, busy } = useRun();
  const [vendorId, setVendorId] = useState("");
  const [adding, setAdding] = useState(false);
  const [billNumber, setBillNumber] = useState("");
  const [billDate, setBillDate] = useState(today());
  const [dueDate, setDueDate] = useState("");
  const [lines, setLines] = useState([{ description: "", accountId: "", amount: "" }]);
  const parsed = lines.map((l) => ({ ...l, minor: parseMoney(l.amount) }));
  const total = parsed.reduce((t, l) => t + (l.minor ?? 0), 0);
  const valid = vendorId && billNumber.trim() && parsed.every((l) => l.description.trim() && l.accountId && l.minor && l.minor > 0);
  const chooseVendor = (id: string) => {
    setVendorId(id);
    const v = vendors?.find((x) => x.id === id);
    if (v?.defaultAccountId) setLines(lines.map((l) => (l.accountId ? l : { ...l, accountId: v.defaultAccountId! })));
  };
  return (
    <Page title="New bill" subtitle="Approvers are notified. A bill reaches the books only once approved and posted.">
      <Card>
        <div className="row">
          <Field label="Vendor"><span className="inline"><ContactSelect kind="vendor" value={vendorId} onChange={chooseVendor} /><button type="button" className="small" onClick={() => setAdding(true)}>New</button></span></Field>
          <Field label="Vendor's bill number"><input value={billNumber} onChange={(e) => setBillNumber(e.target.value)} /></Field>
          <Field label="Bill date"><input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} /></Field>
          <Field label="Due date" hint="Empty: vendor terms"><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
        </div>
        <table className="t lines">
          <thead><tr><th>Description</th><th>Account</th><th className="num">Amount</th><th /></tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={i}>
              <td><input value={l.description} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)))} /></td>
              <td><AccountSelect value={l.accountId} onChange={(v) => setLines(lines.map((x, k) => (k === i ? { ...x, accountId: v } : x)))} types={["expense", "asset"]} /></td>
              <td><MoneyInput value={l.amount} onChange={(v) => setLines(lines.map((x, k) => (k === i ? { ...x, amount: v } : x)))} /></td>
              <td>{lines.length > 1 ? <button className="icon" aria-label="Remove line" onClick={() => setLines(lines.filter((_, k) => k !== i))}>×</button> : null}</td>
            </tr>
          ))}</tbody>
          <tfoot><tr><td colSpan={2}><button className="small" onClick={() => setLines([...lines, { description: "", accountId: "", amount: "" }])}>Add line</button></td><td className="num"><strong><Money minor={total} /></strong></td><td /></tr></tfoot>
        </table>
        <div className="modal-actions">
          <a className="button" href="#/bills">Cancel</a>
          <button className="primary" disabled={!valid || busy} onClick={async () => {
            const id = await run(() => create({ vendorId, billNumber, billDate, ...(dueDate ? { dueDate } : {}), lines: parsed.map((l) => ({ description: l.description, accountId: l.accountId, amountMinor: l.minor! })) }), "Bill captured");
            if (id) window.location.hash = `/bills/${id}`;
          }}>Save</button>
        </div>
      </Card>
      {adding ? <ContactForm kind="vendor" onClose={() => setAdding(false)} onCreated={chooseVendor} /> : null}
    </Page>
  );
}

function BillView({ id }: { id: string }) {
  const view = useQuery(api.bills.get, { id });
  const approve = useMutation(api.bills.approve);
  const post = useMutation(api.bills.post);
  const voidBill = useMutation(api.bills.voidBill);
  const can = useCan();
  const { run, busy } = useRun();
  const [paying, setPaying] = useState(false);
  if (view === undefined) return <Loading />;
  if (view === null) return <Page title="Not found"><Empty>No such bill in this organization.</Empty></Page>;
  const b = view.bill;
  return (
    <Page
      title={`${view.vendor?.name} · ${b.billNumber}`}
      subtitle={<>dated {fmtDate(b.billDate)} · due {fmtDate(b.dueDate)} · <Status value={view.derivedStatus} /></>}
      actions={<span className="actions">
        {b.status === "draft" && can("bills.approve") ? <button className="primary" disabled={busy} onClick={() => run(() => approve({ id }), "Approved")}>Approve</button> : null}
        {b.status === "approved" && can("bills.post") ? <button className="primary" disabled={busy} onClick={() => run(() => post({ id }), "Posted to payables")}>Post</button> : null}
        {b.status === "posted" && view.balanceMinor > 0 && can("payments.record") ? <button className="primary" onClick={() => setPaying(true)}>Pay</button> : null}
        {b.status !== "void" && view.paidMinor === 0 && can("bills.approve") ? <button onClick={() => { const reason = prompt("Why void this bill?"); if (reason) void run(() => voidBill({ id, date: today(), reason }), "Voided"); }}>Void…</button> : null}
      </span>}
    >
      <Card>
        <table className="t">
          <thead><tr><th>Description</th><th>Account</th><th className="num">Amount</th></tr></thead>
          <tbody>{b.lines.map((l, i) => <tr key={i}><td>{l.description}</td><td><Link to={`accounting/account/${l.accountId}`}>account</Link></td><td className="num"><Money minor={l.amountMinor} /></td></tr>)}</tbody>
          <tfoot><tr><td colSpan={2}>Total</td><td className="num"><Money minor={b.totalMinor} /></td></tr>{b.status === "posted" ? <tr><td colSpan={2}>Balance</td><td className="num"><Money minor={view.balanceMinor} /></td></tr> : null}</tfoot>
        </table>
        <p className="small">{b.approvedBy ? `Approved by ${b.approvedBy}. ` : ""}{b.journalEntryId ? <>Posted as <Link to={`transactions/${b.journalEntryId}`}>journal entry</Link>.</> : null}</p>
      </Card>
      <Receipts subjectType="bill" subjectId={b.id} receipts={view.receipts} editable={b.status !== "void"} />
      <Card title="History"><ul className="history">{view.history.map((h) => <li key={h.id}><strong>{h.type}</strong> by {h.actor} · {fmtTime(h.at)}</li>)}</ul></Card>
      {paying ? <PaymentForm direction="made" contactId={b.vendorId} documentId={b.id} balance={view.balanceMinor} label={b.billNumber} onClose={() => setPaying(false)} /> : null}
    </Page>
  );
}
