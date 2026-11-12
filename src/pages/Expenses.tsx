import { useState } from "react";
import { useFeltKit } from "@feltdb/feltkit/react";
import { AccountSelect, api, Badge, Card, ContactSelect, Empty, Field, fmtDate, fmtTime, Link, Loading, Money, MoneyInput, Page, parseMoney, Status, Tabs, today, useCan, useMutation, useQuery, useRun } from "../lib";

export function Expenses({ path }: { path: string[] }) {
  if (path[0] === "new") return <ExpenseEditor />;
  if (path[0]) return <ExpenseView id={path[0]} />;
  return <ExpenseList />;
}

function ExpenseList() {
  const [status, setStatus] = useState<"draft" | "approved" | "rejected">("draft");
  const rows = useQuery(api.expenses.list, { status });
  const can = useCan();
  return (
    <Page title="Expenses" subtitle="Recorded with receipts, approved into the books." actions={can("expenses.write") ? <a className="button primary" href="#/expenses/new">Record expense</a> : null}>
      <Tabs value={status} onChange={setStatus} tabs={[["draft", "Awaiting approval"], ["approved", "Approved"], ["rejected", "Rejected"]]} />
      <Card>
        {!rows ? <Loading /> : rows.length === 0 ? <Empty>No expenses here.</Empty> : (
          <table className="t">
            <thead><tr><th>Date</th><th>Description</th><th>Vendor</th><th>Receipt</th><th>Bank</th><th className="num">Amount</th></tr></thead>
            <tbody>{rows.map((e) => <tr key={e.id}><td>{fmtDate(e.date)}</td><td><Link to={`expenses/${e.id}`}>{e.description}</Link></td><td>{e.vendorName ?? ""}</td><td>{e.receiptCount ? <Badge tone="ok">{e.receiptCount}</Badge> : <Badge tone="warn">missing</Badge>}</td><td>{e.bankTransactionId ? <Badge tone="ok">matched</Badge> : ""}</td><td className="num"><Money minor={e.amountMinor} /></td></tr>)}</tbody>
          </table>
        )}
      </Card>
    </Page>
  );
}

function ExpenseEditor({ existing }: { existing?: { id: string; date: string; vendorId?: string; description: string; amountMinor: number; expenseAccountId: string; paidFromAccountId: string } }) {
  const create = useMutation(api.expenses.create);
  const update = useMutation(api.expenses.update);
  const { run, busy } = useRun();
  const [date, setDate] = useState(existing?.date ?? today());
  const [vendorId, setVendorId] = useState(existing?.vendorId ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [amount, setAmount] = useState(existing ? (existing.amountMinor / 100).toFixed(2) : "");
  const [expenseAccountId, setExpense] = useState(existing?.expenseAccountId ?? "");
  const [paidFromAccountId, setPaidFrom] = useState(existing?.paidFromAccountId ?? "");
  const minor = parseMoney(amount);
  const valid = description.trim() && minor && minor > 0 && expenseAccountId && paidFromAccountId;
  return (
    <Page title={existing ? "Edit expense" : "Record an expense"}>
      <Card>
        <form onSubmit={async (e) => {
          e.preventDefault();
          const payload = { date, description, amountMinor: minor!, expenseAccountId, paidFromAccountId, ...(vendorId ? { vendorId } : {}) };
          const r = existing ? await run(() => update({ id: existing.id, ...payload }), "Saved") : await run(() => create(payload), "Recorded — attach the receipt next");
          if (r) window.location.hash = `/expenses/${existing?.id ?? (r as string)}`;
        }}>
          <div className="row">
            <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Amount"><MoneyInput value={amount} onChange={setAmount} /></Field>
            <Field label="Vendor" hint="Optional"><ContactSelect kind="vendor" value={vendorId} onChange={setVendorId} /></Field>
          </div>
          <Field label="Description"><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Client lunch" /></Field>
          <div className="row">
            <Field label="Category"><AccountSelect value={expenseAccountId} onChange={setExpense} types={["expense", "asset"]} /></Field>
            <Field label="Paid from"><AccountSelect value={paidFromAccountId} onChange={setPaidFrom} subtypes={["cash", "bank", "credit_card"]} /></Field>
          </div>
          <div className="modal-actions"><a className="button" href="#/expenses">Cancel</a><button className="primary" disabled={!valid || busy}>Save</button></div>
        </form>
      </Card>
    </Page>
  );
}

function ExpenseView({ id }: { id: string }) {
  const view = useQuery(api.expenses.get, { id });
  const approve = useMutation(api.expenses.approve);
  const reject = useMutation(api.expenses.reject);
  const can = useCan();
  const { run, busy } = useRun();
  const [editing, setEditing] = useState(false);
  if (view === undefined) return <Loading />;
  if (view === null) return <Page title="Not found"><Empty>No such expense in this organization.</Empty></Page>;
  const e = view.expense;
  if (editing) return <ExpenseEditor existing={{ id: e.id, date: e.date, description: e.description, amountMinor: e.amountMinor, expenseAccountId: e.expenseAccountId, paidFromAccountId: e.paidFromAccountId, ...(e.vendorId ? { vendorId: e.vendorId } : {}) }} />;
  return (
    <Page
      title={e.description}
      subtitle={<><Money minor={e.amountMinor} /> · {fmtDate(e.date)} · <Status value={e.status} /></>}
      actions={<span className="actions">
        {e.status === "draft" && can("expenses.write") ? <button onClick={() => setEditing(true)}>Edit</button> : null}
        {e.status === "draft" && can("expenses.approve") ? <><button className="primary" disabled={busy} onClick={() => run(() => approve({ id }), "Approved and posted")}>Approve</button><button onClick={() => { const note = prompt("Why reject?"); if (note) void run(() => reject({ id, note }), "Rejected"); }}>Reject…</button></> : null}
      </span>}
    >
      <Card>
        <dl className="meta">
          <dt>Category</dt><dd><Link to={`accounting/account/${e.expenseAccountId}`}>account</Link></dd>
          <dt>Paid from</dt><dd><Link to={`accounting/account/${e.paidFromAccountId}`}>account</Link></dd>
          <dt>Recorded by</dt><dd>{e.createdBy}, {fmtTime(e.createdAt)}</dd>
          {e.reviewedBy ? <><dt>Reviewed by</dt><dd>{e.reviewedBy}{e.reviewNote ? ` — ${e.reviewNote}` : ""}</dd></> : null}
          {e.journalEntryId ? <><dt>Journal entry</dt><dd><Link to={`transactions/${e.journalEntryId}`}>view</Link></dd></> : null}
          <dt>Bank transaction</dt><dd>{e.bankTransactionId ? <Badge tone="ok">matched</Badge> : <span className="muted">not matched yet</span>}</dd>
        </dl>
      </Card>
      <Receipts subjectType="expense" subjectId={e.id} receipts={view.receipts} editable={e.status !== "rejected"} />
      <Card title="History"><ul className="history">{view.history.map((h) => <li key={h.id}><strong>{h.type}</strong> by {h.actor} · {fmtTime(h.at)}</li>)}</ul></Card>
    </Page>
  );
}

type Receipt = { id: string; name: string; size: number; uploadedBy: string; at: number; contentType?: string };

/** Receipts: uploaded with a single-use link fixed to this organization and record, then bound by the server. */
export function Receipts({ subjectType, subjectId, receipts, editable }: { subjectType: "expense" | "bill"; subjectId: string; receipts: Receipt[]; editable: boolean }) {
  const client = useFeltKit();
  const uploadLink = useMutation(api.expenses.uploadLink);
  const attach = useMutation(api.expenses.attach);
  const can = useCan();
  const { run, busy } = useRun();
  const open = async (receiptId: string) => {
    const link = await run(() => client.query(api.expenses.receiptLink, { receiptId, inline: true }));
    if (link) window.open(client.fileUrl(link), "_blank", "noopener");
  };
  return (
    <Card title="Receipts" actions={editable && can("expenses.write") ? (
      <label className="button small">
        {busy ? "Uploading…" : "Attach receipt"}
        <input type="file" hidden accept="image/*,application/pdf" onChange={async (ev) => {
          const file = ev.target.files?.[0];
          ev.target.value = "";
          if (!file) return;
          await run(async () => {
            const link = await uploadLink({ subjectType, subjectId, name: file.name, ...(file.type ? { contentType: file.type } : {}) });
            const uploaded = await client.uploadFile(link, file);
            return attach({ fileId: uploaded.id });
          }, "Receipt attached");
        }} />
      </label>
    ) : null}>
      {receipts.length === 0 ? <Empty>No receipt attached.</Empty> : (
        <ul className="history">{receipts.map((r) => <li key={r.id}><button className="linklike" onClick={() => void open(r.id)}>{r.name}</button> <span className="muted">{Math.ceil(r.size / 1024)} KB · {r.uploadedBy} · {fmtTime(r.at)}</span></li>)}</ul>
      )}
    </Card>
  );
}
