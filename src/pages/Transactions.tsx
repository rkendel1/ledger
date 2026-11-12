import { useState } from "react";
import { AccountSelect, api, Badge, Card, Empty, Field, fmtDate, fmtTime, Link, Loading, Money, MoneyInput, Page, parseMoney, SOURCE_LABEL, Status, Tabs, today, useCan, useMutation, useQuery, useRun } from "../lib";

export function Transactions({ path }: { path: string[] }) {
  if (path[0] === "new") return <EntryEditor />;
  if (path[0]) return <EntryView id={path[0]} />;
  return <Journal />;
}

function Journal() {
  const [status, setStatus] = useState<"posted" | "draft">("posted");
  const entries = useQuery(api.journal.list, { status });
  const can = useCan();
  return (
    <Page title="Transactions" subtitle="Every journal entry. Posted entries are permanent; corrections are reversals." actions={can("journal.draft") ? <a className="button primary" href="#/transactions/new">New journal entry</a> : null}>
      <Tabs value={status} onChange={setStatus} tabs={[["posted", "Posted"], ["draft", "Drafts"]]} />
      <Card>
        {!entries ? <Loading /> : entries.length === 0 ? <Empty>No {status} entries.</Empty> : (
          <table className="t">
            <thead><tr><th>#</th><th>Date</th><th>Description</th><th>Source</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{e.status === "posted" ? <Link to={`transactions/${e.id}`}>{e.number}</Link> : <Link to={`transactions/${e.id}`}>draft</Link>}</td>
                  <td>{fmtDate(e.date)}</td>
                  <td>{e.description}{e.reversalOf ? <Badge tone="info">reversal</Badge> : null}{e.reversed ? <Badge tone="muted">reversed</Badge> : null}{e.proposalId ? <Badge tone="info">approved proposal</Badge> : null}</td>
                  <td className="muted">{SOURCE_LABEL[e.sourceType]}</td>
                  <td className="num"><Money minor={e.totalMinor} /></td>
                  <td className="muted small">{e.createdBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </Page>
  );
}

type Line = { accountId: string; debit: string; credit: string; memo: string };

function EntryEditor({ draft }: { draft?: { id: string; date: string; description: string; reference?: string; lines: Array<{ accountId: string; debit: number; credit: number; memo?: string }> } }) {
  const createDraft = useMutation(api.journal.createDraft);
  const updateDraft = useMutation(api.journal.updateDraft);
  const createAndPost = useMutation(api.journal.createAndPost);
  const can = useCan();
  const { run, busy } = useRun();
  const [date, setDate] = useState(draft?.date ?? today());
  const [description, setDescription] = useState(draft?.description ?? "");
  const [reference, setReference] = useState(draft?.reference ?? "");
  const toLine = (l: { accountId: string; debit: number; credit: number; memo?: string }): Line => ({ accountId: l.accountId, debit: l.debit ? (l.debit / 100).toFixed(2) : "", credit: l.credit ? (l.credit / 100).toFixed(2) : "", memo: l.memo ?? "" });
  const [lines, setLines] = useState<Line[]>(draft ? draft.lines.map(toLine) : [{ accountId: "", debit: "", credit: "", memo: "" }, { accountId: "", debit: "", credit: "", memo: "" }]);
  const parsed = lines.map((l) => ({ accountId: l.accountId, debit: l.debit.trim() ? parseMoney(l.debit) : 0, credit: l.credit.trim() ? parseMoney(l.credit) : 0, memo: l.memo }));
  const debits = parsed.reduce((t, l) => t + (l.debit ?? 0), 0);
  const credits = parsed.reduce((t, l) => t + (l.credit ?? 0), 0);
  const valid = description.trim() && parsed.length >= 2 && parsed.every((l) => l.accountId && l.debit !== null && l.credit !== null && (l.debit! > 0) !== (l.credit! > 0)) && debits === credits && debits > 0;
  const payload = { date, description, ...(reference ? { reference } : {}), lines: parsed.map((l) => ({ accountId: l.accountId, debit: l.debit!, credit: l.credit!, ...(l.memo ? { memo: l.memo } : {}) })) };
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  return (
    <Page title={draft ? "Edit draft" : "New journal entry"} subtitle="Every entry must balance. A draft changes no balance until it is posted.">
      <Card>
        <div className="row">
          <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Description"><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Accrue March rent" /></Field>
          <Field label="Reference"><input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" /></Field>
        </div>
        <table className="t lines">
          <thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th><th>Memo</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td><AccountSelect value={l.accountId} onChange={(v) => set(i, { accountId: v })} /></td>
                <td><MoneyInput value={l.debit} onChange={(v) => set(i, { debit: v, ...(v ? { credit: "" } : {}) })} placeholder="" /></td>
                <td><MoneyInput value={l.credit} onChange={(v) => set(i, { credit: v, ...(v ? { debit: "" } : {}) })} placeholder="" /></td>
                <td><input value={l.memo} onChange={(e) => set(i, { memo: e.target.value })} /></td>
                <td>{lines.length > 2 ? <button className="icon" aria-label="Remove line" onClick={() => setLines(lines.filter((_, k) => k !== i))}>×</button> : null}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td><button className="small" onClick={() => setLines([...lines, { accountId: "", debit: "", credit: "", memo: "" }])}>Add line</button></td><td className="num"><Money minor={debits} /></td><td className="num"><Money minor={credits} /></td><td colSpan={2} className={debits === credits ? "ok" : "warn"}>{debits === credits ? "Balanced" : <>Out by <Money minor={debits - credits} /></>}</td></tr></tfoot>
        </table>
        <div className="modal-actions">
          <a className="button" href="#/transactions">Cancel</a>
          <button disabled={!valid || busy} onClick={async () => {
            const r = draft ? await run(() => updateDraft({ id: draft.id, ...payload }), "Draft saved") : await run(() => createDraft(payload), "Draft saved");
            if (r) window.location.hash = draft ? `/transactions/${draft.id}` : `/transactions/${r as string}`;
          }}>Save draft</button>
          {can("journal.post") && !draft ? <button className="primary" disabled={!valid || busy} onClick={async () => {
            const r = await run(() => createAndPost({ ...payload, idempotencyKey: `ui-${crypto.randomUUID()}` }), "Posted");
            if (r) window.location.hash = `/transactions/${r.id}`;
          }}>Post</button> : null}
        </div>
      </Card>
    </Page>
  );
}

function EntryView({ id }: { id: string }) {
  const view = useQuery(api.journal.get, { id });
  const post = useMutation(api.journal.post);
  const del = useMutation(api.journal.deleteDraft);
  const reverse = useMutation(api.journal.reverse);
  const can = useCan();
  const { run, busy } = useRun();
  const [editing, setEditing] = useState(false);
  if (view === undefined) return <Loading />;
  if (view === null) return <Page title="Not found"><Empty>No such entry in this organization.</Empty></Page>;
  const e = view.entry;
  if (editing && e.status === "draft") return <EntryEditor draft={{ id: e.id, date: e.date, description: e.description, ...(e.reference ? { reference: e.reference } : {}), lines: view.lines }} />;
  const reversible = e.status === "posted" && !view.reversedBy && !e.reversalOf && ["manual", "opening_balance", "proposal"].includes(e.sourceType);
  return (
    <Page
      title={e.status === "posted" ? `Journal entry #${e.number}` : "Draft journal entry"}
      subtitle={<>{fmtDate(e.date)} · {SOURCE_LABEL[e.sourceType]} · <Status value={e.status} /></>}
      actions={<span className="actions">
        {e.status === "draft" && can("journal.draft") ? <><button onClick={() => setEditing(true)}>Edit</button><button onClick={() => confirm("Delete this draft?") && run(() => del({ id }), "Draft deleted").then((r) => { if (r) window.location.hash = "/transactions"; })}>Delete</button></> : null}
        {e.status === "draft" && can("journal.post") ? <button className="primary" disabled={busy} onClick={() => run(() => post({ id }), "Posted")}>Post</button> : null}
        {reversible && can("journal.reverse") ? <button onClick={() => {
          const reason = prompt("Why reverse this entry? The original stays; a mirrored entry is posted.");
          if (!reason) return;
          const date = prompt("Date of the reversal (YYYY-MM-DD)", today());
          if (date) void run(() => reverse({ id, date, reason }), "Reversed");
        }}>Reverse…</button> : null}
      </span>}
    >
      <Card title={e.description}>
        {e.reference ? <p className="muted">Reference {e.reference}</p> : null}
        {view.reversalOf ? <p>Reverses <Link to={`transactions/${view.reversalOf.id}`}>#{view.reversalOf.number}</Link>{e.reason ? `: ${e.reason}` : ""}</p> : null}
        {view.reversedBy ? <p><Badge tone="muted">reversed</Badge> by <Link to={`transactions/${view.reversedBy.id}`}>#{view.reversedBy.number}</Link> on {fmtDate(view.reversedBy.date)}</p> : null}
        {e.sourceId ? <p className="muted small">From {SOURCE_LABEL[e.sourceType]} {sourceLink(e.sourceType, e.sourceId)}</p> : null}
        <table className="t">
          <thead><tr><th>Account</th><th>Memo</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
          <tbody>{view.lines.map((l, i) => <tr key={i}><td><Link to={`accounting/account/${l.accountId}`}>{l.account.number} · {l.account.name}</Link></td><td className="muted">{l.memo}</td><td className="num">{l.debit ? <Money minor={l.debit} /> : ""}</td><td className="num">{l.credit ? <Money minor={l.credit} /> : ""}</td></tr>)}</tbody>
          <tfoot><tr><td colSpan={2}>Total</td><td className="num"><Money minor={e.totalMinor} /></td><td className="num"><Money minor={e.totalMinor} /></td></tr></tfoot>
        </table>
        <dl className="meta">
          <dt>Created</dt><dd>{e.createdBy}, {fmtTime(e.createdAt)}</dd>
          {e.postedBy ? <><dt>Posted</dt><dd>{e.postedBy}, {fmtTime(e.postedAt!)}</dd></> : null}
          {e.proposalId ? <><dt>Approved proposal</dt><dd>approved by {e.approvedBy}</dd></> : null}
        </dl>
      </Card>
      <Card title="History">
        <ul className="history">{view.history.map((h) => <li key={h.id}><strong>{h.type}</strong> by {h.actor}{h.actorType === "agent" ? " (agent)" : ""} · {fmtTime(h.at)}</li>)}</ul>
      </Card>
    </Page>
  );
}

function sourceLink(type: string, id: string) {
  const to: Record<string, string> = { invoice: `invoices/${id}`, credit_note: "invoices", bill: `bills/${id}`, expense: `expenses/${id}`, bank: "banking" };
  return to[type] ? <Link to={to[type]!}>record</Link> : null;
}
