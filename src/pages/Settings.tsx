import { useState } from "react";
import { AccountSettings, TenantSettings } from "@feltdb/feltkit/react";
import { api, Badge, Card, Empty, Field, fmtTime, Loading, Money, Page, Tabs, useCan, useMutation, useQuery, useRun } from "../lib";

export function Settings() {
  const [tab, setTab] = useState<"org" | "members" | "integrity" | "inbox" | "account">("org");
  return (
    <Page title="Settings">
      <Tabs value={tab} onChange={setTab} tabs={[["org", "Organization"], ["members", "Members & roles"], ["integrity", "Integrity"], ["inbox", "Notifications"], ["account", "Your account"]]} />
      {tab === "org" ? <Org /> : tab === "members" ? <Members /> : tab === "integrity" ? <Integrity /> : tab === "inbox" ? <Inbox /> : <Card><AccountSettings /></Card>}
    </Page>
  );
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function Org() {
  const s = useQuery(api.org.settings, {});
  const update = useMutation(api.org.update);
  const can = useCan();
  const { run, busy } = useRun();
  const [legalName, setLegalName] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  if (!s) return <Loading />;
  return (
    <Card title="Organization">
      <form onSubmit={(e) => { e.preventDefault(); void run(() => update({ ...(legalName ? { legalName } : {}), ...(displayName ? { displayName } : {}) }), "Saved"); }}>
        <div className="row">
          <Field label="Legal name"><input disabled={!can("org.manage")} value={legalName ?? s.legalName} onChange={(e) => setLegalName(e.target.value)} /></Field>
          <Field label="Display name"><input disabled={!can("org.manage")} value={displayName ?? s.displayName} onChange={(e) => setDisplayName(e.target.value)} /></Field>
        </div>
        <dl className="meta">
          <dt>Base currency</dt><dd>{s.baseCurrency}</dd>
          <dt>Fiscal year starts</dt><dd>{MONTHS[s.fiscalYearStartMonth - 1]}</dd>
          <dt>Books closed through</dt><dd>{s.closedThrough || "nothing closed"}</dd>
        </dl>
        {can("org.manage") ? <button className="primary" disabled={busy}>Save</button> : null}
      </form>
    </Card>
  );
}

const ROLE_HELP: Array<[string, string]> = [
  ["owner", "Everything, including members and settings."],
  ["admin", "Everything financial, plus members."],
  ["accountant", "Posts and reverses journals, approves bills and expenses, reconciles, closes periods."],
  ["bookkeeper", "Records invoices, bills, expenses and payments; imports and categorizes bank transactions; drafts journals."],
  ["reviewer", "Reads everything; changes nothing."],
  ["assistant", "An agent: reads and proposes. It can never execute a financial action."],
];

function Members() {
  return (
    <>
      <Card title="Roles"><table className="t"><tbody>{ROLE_HELP.map(([r, d]) => <tr key={r}><td><Badge tone="info">{r}</Badge></td><td>{d}</td></tr>)}</tbody></table></Card>
      <Card><TenantSettings /></Card>
    </>
  );
}

function Integrity() {
  const r = useQuery(api.integrity.check, {});
  if (!r) return <Loading />;
  return (
    <Card title="Ledger integrity" actions={r.ok ? <Badge tone="ok">all checks pass</Badge> : <Badge tone="bad">{r.problems.length} problem{r.problems.length === 1 ? "" : "s"}</Badge>}>
      <p className="muted">Recomputed now from stored records: every posted entry balances and has gapless numbering, reversals mirror their originals, drafts have no ledger lines, the trial balance is even, and receivables and payables equal their open documents.</p>
      <dl className="meta">
        <dt>Posted entries</dt><dd>{r.postedEntries}</dd>
        <dt>Drafts</dt><dd>{r.drafts}</dd>
        <dt>Ledger lines</dt><dd>{r.lines}</dd>
        <dt>Total debits</dt><dd><Money minor={r.debitsMinor} /></dd>
        <dt>Total credits</dt><dd><Money minor={r.creditsMinor} /></dd>
      </dl>
      {r.problems.length ? <ul className="discrepancies">{r.problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
    </Card>
  );
}

function Inbox() {
  const items = useQuery(api.inbox.list, {});
  const markRead = useMutation(api.inbox.markRead);
  const { run } = useRun();
  if (!items) return <Loading />;
  return (
    <Card title="Your notifications">
      {items.length === 0 ? <Empty>No notifications.</Empty> : (
        <ul className="history">{items.map((n) => (
          <li key={n.id} className={n.read ? "muted" : ""}>
            <strong>{n.title}</strong> · {fmtTime(Date.parse(n.createdAt))}
            {(n.data as { billId?: string } | null)?.billId ? <> · <a className="link" href={`#/bills/${(n.data as { billId: string }).billId}`}>open</a></> : null}
            {!n.read ? <button className="small" onClick={() => run(() => markRead({ id: n.id }))}>Mark read</button> : null}
          </li>
        ))}</ul>
      )}
    </Card>
  );
}
