import { useState } from "react";
import { AccountSelect, api, Card, ContactSelect, Empty, Field, fmtDate, fmtTime, Link, Loading, Modal, Money, MoneyInput, Page, parseMoney, Status, Tabs, today, useCan, useMutation, useQuery, useRun } from "../lib";
import { ContactForm, ContactsPanel } from "./Contacts";

export function Invoices({ path }: { path: string[] }) {
  if (path[0] === "new") return <InvoiceEditor />;
  if (path[0] === "customers") return <Page title="Customers"><ContactsPanel kind="customer" /></Page>;
  if (path[0]) return <InvoiceView id={path[0]} />;
  return <InvoiceList />;
}

function InvoiceList() {
  const invoices = useQuery(api.invoices.list, {});
  const [filter, setFilter] = useState<"open" | "all" | "draft" | "paid">("open");
  const can = useCan();
  const rows = (invoices ?? []).filter((i) => filter === "all" || (filter === "open" ? ["issued", "partially_paid", "overdue"].includes(i.derivedStatus) : filter === "draft" ? i.status === "draft" : i.derivedStatus === "paid"));
  return (
    <Page title="Invoices" subtitle="Issuing posts to receivables; payments and credit notes settle it." actions={<span className="actions"><a className="button" href="#/invoices/customers">Customers</a>{can("invoices.write") ? <a className="button primary" href="#/invoices/new">New invoice</a> : null}</span>}>
      <Tabs value={filter} onChange={setFilter} tabs={[["open", "Open"], ["draft", "Drafts"], ["paid", "Paid"], ["all", "All"]]} />
      <Card>
        {!invoices ? <Loading /> : rows.length === 0 ? <Empty>No invoices here.</Empty> : (
          <table className="t">
            <thead><tr><th>Number</th><th>Customer</th><th>Issued</th><th>Due</th><th>Status</th><th className="num">Total</th><th className="num">Balance</th></tr></thead>
            <tbody>{rows.map((i) => <tr key={i.id}><td><Link to={`invoices/${i.id}`}>{i.number ?? "Draft"}</Link></td><td>{i.customerName}</td><td>{fmtDate(i.issueDate)}</td><td>{fmtDate(i.dueDate)}</td><td><Status value={i.derivedStatus} /></td><td className="num"><Money minor={i.totalMinor} /></td><td className="num"><Money minor={i.balanceMinor} /></td></tr>)}</tbody>
          </table>
        )}
      </Card>
    </Page>
  );
}

type EditLine = { description: string; quantity: string; price: string; accountId: string; taxRateId: string };

function InvoiceEditor({ existing }: { existing?: { id: string; customerId: string; issueDate: string; dueDate: string; memo?: string; lines: Array<{ description: string; quantityMilli: number; unitPriceMinor: number; accountId: string; taxRateId?: string }> } }) {
  const create = useMutation(api.invoices.create);
  const update = useMutation(api.invoices.update);
  const rates = useQuery(api.invoices.listTaxRates, {});
  const { run, busy } = useRun();
  const [customerId, setCustomerId] = useState(existing?.customerId ?? "");
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [issueDate, setIssueDate] = useState(existing?.issueDate ?? today());
  const [dueDate, setDueDate] = useState(existing?.dueDate ?? "");
  const [memo, setMemo] = useState(existing?.memo ?? "");
  const [lines, setLines] = useState<EditLine[]>(existing ? existing.lines.map((l) => ({ description: l.description, quantity: String(l.quantityMilli / 1000), price: (l.unitPriceMinor / 100).toFixed(2), accountId: l.accountId, taxRateId: l.taxRateId ?? "" })) : [{ description: "", quantity: "1", price: "", accountId: "", taxRateId: "" }]);
  const parsed = lines.map((l) => {
    const q = /^\d+(\.\d{1,3})?$/.test(l.quantity.trim()) ? Math.round(Number(l.quantity) * 1000) : null;
    const p = parseMoney(l.price);
    const amount = q !== null && p !== null ? Math.floor((q * p + 500) / 1000) : null;
    const rate = rates?.find((r) => r.id === l.taxRateId);
    const tax = amount !== null && rate ? Math.floor((amount * rate.rateBp + 5000) / 10000) : 0;
    return { ...l, quantityMilli: q, unitPriceMinor: p, amount, tax };
  });
  const subtotal = parsed.reduce((t, l) => t + (l.amount ?? 0), 0);
  const tax = parsed.reduce((t, l) => t + l.tax, 0);
  const valid = customerId && parsed.every((l) => l.description.trim() && l.quantityMilli && l.quantityMilli > 0 && l.unitPriceMinor !== null && l.unitPriceMinor >= 0 && l.accountId);
  const set = (i: number, patch: Partial<EditLine>) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  return (
    <Page title={existing ? "Edit draft invoice" : "New invoice"} subtitle="Amounts are computed exactly in cents: quantity × price, rounded half up; tax per line.">
      <Card>
        <div className="row">
          <Field label="Customer"><span className="inline"><ContactSelect kind="customer" value={customerId} onChange={setCustomerId} /><button type="button" className="small" onClick={() => setAddingCustomer(true)}>New</button></span></Field>
          <Field label="Issue date"><input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></Field>
          <Field label="Due date" hint="Empty: the customer's payment terms"><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
        </div>
        <table className="t lines">
          <thead><tr><th>Description</th><th>Qty</th><th>Price</th><th>Revenue account</th><th>Tax</th><th className="num">Amount</th><th /></tr></thead>
          <tbody>
            {parsed.map((l, i) => (
              <tr key={i}>
                <td><input value={l.description} onChange={(e) => set(i, { description: e.target.value })} /></td>
                <td><input className="qty" inputMode="decimal" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} /></td>
                <td><MoneyInput value={l.price} onChange={(v) => set(i, { price: v })} /></td>
                <td><AccountSelect value={l.accountId} onChange={(v) => set(i, { accountId: v })} types={["revenue"]} /></td>
                <td><select value={l.taxRateId} onChange={(e) => set(i, { taxRateId: e.target.value })}><option value="">None</option>{(rates ?? []).filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></td>
                <td className="num"><Money minor={l.amount} /></td>
                <td>{lines.length > 1 ? <button className="icon" aria-label="Remove line" onClick={() => setLines(lines.filter((_, k) => k !== i))}>×</button> : null}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={5}><button className="small" onClick={() => setLines([...lines, { description: "", quantity: "1", price: "", accountId: lines[lines.length - 1]?.accountId ?? "", taxRateId: "" }])}>Add line</button></td><td className="num">Subtotal <Money minor={subtotal} /></td><td /></tr>
            <tr><td colSpan={5} /><td className="num">Tax <Money minor={tax} /></td><td /></tr>
            <tr><td colSpan={5} /><td className="num"><strong>Total <Money minor={subtotal + tax} /></strong></td><td /></tr>
          </tfoot>
        </table>
        <Field label="Memo"><textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} /></Field>
        <div className="modal-actions">
          <a className="button" href="#/invoices">Cancel</a>
          <button className="primary" disabled={!valid || busy} onClick={async () => {
            const payload = { customerId, issueDate, lines: parsed.map((l) => ({ description: l.description, quantityMilli: l.quantityMilli!, unitPriceMinor: l.unitPriceMinor!, accountId: l.accountId, ...(l.taxRateId ? { taxRateId: l.taxRateId } : {}) })), ...(memo ? { memo } : {}) };
            if (existing) {
              const r = await run(() => update({ id: existing.id, ...payload, dueDate: dueDate || existing.dueDate }), "Draft saved");
              if (r) window.location.hash = `/invoices/${existing.id}`;
            } else {
              const id = await run(() => create({ ...payload, ...(dueDate ? { dueDate } : {}) }), "Draft saved");
              if (id) window.location.hash = `/invoices/${id}`;
            }
          }}>Save draft</button>
        </div>
      </Card>
      {addingCustomer ? <ContactForm kind="customer" onClose={() => setAddingCustomer(false)} onCreated={setCustomerId} /> : null}
    </Page>
  );
}

function InvoiceView({ id }: { id: string }) {
  const view = useQuery(api.invoices.get, { id });
  const issue = useMutation(api.invoices.issue);
  const del = useMutation(api.invoices.deleteDraft);
  const voidInvoice = useMutation(api.invoices.voidInvoice);
  const can = useCan();
  const { run, busy } = useRun();
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [crediting, setCrediting] = useState(false);
  if (view === undefined) return <Loading />;
  if (view === null) return <Page title="Not found"><Empty>No such invoice in this organization.</Empty></Page>;
  const inv = view.invoice;
  if (editing) return <InvoiceEditor existing={{ id: inv.id, customerId: inv.customerId, issueDate: inv.issueDate, dueDate: inv.dueDate, ...(inv.memo ? { memo: inv.memo } : {}), lines: inv.lines }} />;
  return (
    <Page
      title={inv.number ? `Invoice ${inv.number}` : "Draft invoice"}
      subtitle={<>{view.customer?.name} · issued {fmtDate(inv.issueDate)} · due {fmtDate(inv.dueDate)} · <Status value={view.derivedStatus} /></>}
      actions={<span className="actions">
        {inv.status === "draft" && can("invoices.write") ? <><button onClick={() => setEditing(true)}>Edit</button><button onClick={() => confirm("Delete this draft?") && run(() => del({ id }), "Deleted").then((r) => { if (r) window.location.hash = "/invoices"; })}>Delete</button></> : null}
        {inv.status === "draft" && can("invoices.issue") ? <button className="primary" disabled={busy} onClick={() => run(() => issue({ id }), "Issued and posted to receivables")}>Issue</button> : null}
        {inv.status === "issued" && view.balanceMinor > 0 && can("payments.record") ? <button className="primary" onClick={() => setPaying(true)}>Record payment</button> : null}
        {inv.status === "issued" && view.balanceMinor > 0 && can("invoices.issue") ? <button onClick={() => setCrediting(true)}>Credit note</button> : null}
        {inv.status === "issued" && view.paidMinor + view.creditedMinor === 0 && can("invoices.void") ? <button onClick={() => { const reason = prompt("Why void this invoice? Its entry will be reversed."); if (reason) void run(() => voidInvoice({ id, date: today(), reason }), "Voided"); }}>Void…</button> : null}
      </span>}
    >
      <Card>
        <table className="t">
          <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Tax</th><th className="num">Amount</th></tr></thead>
          <tbody>{inv.lines.map((l, i) => <tr key={i}><td>{l.description}</td><td className="num">{l.quantityMilli / 1000}</td><td className="num"><Money minor={l.unitPriceMinor} /></td><td className="num"><Money minor={l.taxMinor} /></td><td className="num"><Money minor={l.amountMinor} /></td></tr>)}</tbody>
          <tfoot>
            <tr><td colSpan={4}>Subtotal</td><td className="num"><Money minor={inv.subtotalMinor} /></td></tr>
            <tr><td colSpan={4}>Tax</td><td className="num"><Money minor={inv.taxMinor} /></td></tr>
            <tr><td colSpan={4}><strong>Total</strong></td><td className="num"><strong><Money minor={inv.totalMinor} /></strong></td></tr>
            {inv.status === "issued" ? <><tr><td colSpan={4}>Paid</td><td className="num"><Money minor={-view.paidMinor} /></td></tr><tr><td colSpan={4}>Credited</td><td className="num"><Money minor={-view.creditedMinor} /></td></tr><tr><td colSpan={4}><strong>Balance</strong></td><td className="num"><strong><Money minor={view.balanceMinor} /></strong></td></tr></> : null}
          </tfoot>
        </table>
        {inv.memo ? <p className="muted">{inv.memo}</p> : null}
        <p className="small">{inv.journalEntryId ? <>Posted as <Link to={`transactions/${inv.journalEntryId}`}>journal entry</Link>. </> : null}{inv.voidEntryId ? <>Voided by <Link to={`transactions/${inv.voidEntryId}`}>reversal</Link>.</> : null}</p>
      </Card>
      {view.creditNotes.length ? <Card title="Credit notes"><table className="t"><tbody>{view.creditNotes.map((c) => <tr key={c.id}><td>{c.number}</td><td>{fmtDate(c.date)}</td><td>{c.reason}</td><td><Link to={`transactions/${c.journalEntryId}`}>entry</Link></td><td className="num"><Money minor={c.totalMinor} /></td></tr>)}</tbody></table></Card> : null}
      <Card title="History"><ul className="history">{view.history.map((h) => <li key={h.id}><strong>{h.type}</strong> by {h.actor} · {fmtTime(h.at)}</li>)}</ul></Card>
      {paying ? <PaymentForm direction="received" contactId={inv.customerId} documentId={inv.id} balance={view.balanceMinor} label={inv.number!} onClose={() => setPaying(false)} /> : null}
      {crediting ? <CreditNoteForm invoiceId={inv.id} balance={view.balanceMinor} onClose={() => setCrediting(false)} /> : null}
    </Page>
  );
}

export function PaymentForm({ direction, contactId, documentId, balance, label, onClose }: { direction: "received" | "made"; contactId: string; documentId: string; balance: number; label: string; onClose: () => void }) {
  const receive = useMutation(api.payments.receive);
  const pay = useMutation(api.payments.pay);
  const { run, busy } = useRun();
  const [amount, setAmount] = useState((balance / 100).toFixed(2));
  const [date, setDate] = useState(today());
  const [accountId, setAccountId] = useState("");
  const [reference, setReference] = useState("");
  const [key] = useState(() => `ui-${crypto.randomUUID()}`);
  const minor = parseMoney(amount);
  const ok = minor !== null && minor > 0 && minor <= balance && accountId;
  return (
    <Modal title={direction === "received" ? `Payment for ${label}` : `Pay bill ${label}`} onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        const common = { date, amountMinor: minor!, accountId, applyTo: [{ documentId, amountMinor: minor! }], idempotencyKey: key, ...(reference ? { reference } : {}) };
        const r = direction === "received" ? await run(() => receive({ customerId: contactId, ...common }), "Payment recorded") : await run(() => pay({ vendorId: contactId, ...common }), "Payment recorded");
        if (r) onClose();
      }}>
        <div className="row">
          <Field label="Amount" hint={`Open balance ${(balance / 100).toFixed(2)}`}><MoneyInput value={amount} onChange={setAmount} /></Field>
          <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <Field label={direction === "received" ? "Deposited to" : "Paid from"}><AccountSelect value={accountId} onChange={setAccountId} subtypes={direction === "received" ? ["bank", "cash"] : ["bank", "cash", "credit_card"]} /></Field>
        <Field label="Reference"><input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Cheque or transfer number" /></Field>
        <div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={!ok || busy}>Record</button></div>
      </form>
    </Modal>
  );
}

function CreditNoteForm({ invoiceId, balance, onClose }: { invoiceId: string; balance: number; onClose: () => void }) {
  const credit = useMutation(api.invoices.creditNote);
  const rates = useQuery(api.invoices.listTaxRates, {});
  const { run, busy } = useRun();
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [taxRateId, setTaxRateId] = useState("");
  const [reason, setReason] = useState("");
  const minor = parseMoney(amount);
  return (
    <Modal title="Credit note" onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        const r = await run(() => credit({ invoiceId, date: today(), reason, lines: [{ description: reason, accountId, amountMinor: minor!, ...(taxRateId ? { taxRateId } : {}) }] }), "Credit note posted");
        if (r) onClose();
      }}>
        <Field label="Reason"><input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <div className="row">
          <Field label="Amount before tax" hint={`Open balance ${(balance / 100).toFixed(2)}`}><MoneyInput value={amount} onChange={setAmount} /></Field>
          <Field label="Tax"><select value={taxRateId} onChange={(e) => setTaxRateId(e.target.value)}><option value="">None</option>{(rates ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
        </div>
        <Field label="Reduce revenue account"><AccountSelect value={accountId} onChange={setAccountId} types={["revenue"]} /></Field>
        <div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !minor || minor <= 0 || !accountId}>Post credit note</button></div>
      </form>
    </Modal>
  );
}
