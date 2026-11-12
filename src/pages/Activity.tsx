import { useState } from "react";
import { api, Badge, Card, Empty, fmtTime, Loading, Page, Status, Tabs, useQuery } from "../lib";
import { linkFor } from "./Overview";
import { ProposalInline } from "./Banking";

export function Activity() {
  const [tab, setTab] = useState<"review" | "proposals" | "audit">("review");
  return (
    <Page title="Activity" subtitle="What needs review, what was proposed and decided, and the audit trail of every financial change.">
      <Tabs value={tab} onChange={setTab} tabs={[["review", "Review queue"], ["proposals", "Proposals"], ["audit", "Audit trail"]]} />
      {tab === "review" ? <Review /> : tab === "proposals" ? <Proposals /> : <Audit />}
    </Page>
  );
}

function Review() {
  const items = useQuery(api.review.queue, {});
  if (!items) return <Loading />;
  if (items.length === 0) return <Card><Empty>Nothing needs review.</Empty></Card>;
  return (
    <Card>
      <ul className="queue">
        {items.map((i, k) => (
          <li key={k}>
            <Badge tone={i.severity === "high" ? "bad" : i.severity === "medium" ? "warn" : "muted"}>{i.kind.replace(/_/g, " ")}</Badge>
            <a className="link" href={linkFor(i.link)}>{i.title}</a>
            <small>{i.detail}</small>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Proposals() {
  const pending = useQuery(api.review.list, { status: "pending" });
  const all = useQuery(api.review.list, {});
  if (!pending || !all) return <Loading />;
  const decided = all.filter((p) => p.status !== "pending");
  return (
    <>
      <Card title={`Pending (${pending.length})`}>
        {pending.length === 0 ? <Empty>No proposals waiting.</Empty> : <ul className="queue">{pending.map((p) => <li key={p.id}><ProposalInline proposal={p} /></li>)}</ul>}
      </Card>
      <Card title="Decided">
        {decided.length === 0 ? <Empty>None yet.</Empty> : (
          <table className="t">
            <thead><tr><th>Proposal</th><th>Source</th><th>Decision</th><th>When</th></tr></thead>
            <tbody>{decided.map((p) => <tr key={p.id}><td>{p.summary}<small className="muted block">{p.rationale}</small></td><td>{p.source}</td><td><Status value={p.status} /> by {p.decidedBy}{p.decisionReason ? ` — ${p.decisionReason}` : ""}</td><td>{p.decidedAt ? fmtTime(p.decidedAt) : ""}</td></tr>)}</tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function Audit() {
  const [subjectType, setSubjectType] = useState("");
  const [actorType, setActorType] = useState("");
  const events = useQuery(api.activity.list, { ...(subjectType ? { subjectType } : {}), ...(actorType ? { actorType } : {}), limit: 300 });
  return (
    <Card actions={<span className="actions">
      <select value={subjectType} onChange={(e) => setSubjectType(e.target.value)} aria-label="Subject"><option value="">Everything</option>{["journal", "invoice", "bill", "payment", "expense", "receipt", "bank", "reconciliation", "proposal", "period", "account", "contact", "org"].map((s) => <option key={s}>{s}</option>)}</select>
      <select value={actorType} onChange={(e) => setActorType(e.target.value)} aria-label="Actor"><option value="">Anyone</option><option value="user">People</option><option value="agent">Agents</option></select>
    </span>}>
      {!events ? <Loading /> : events.length === 0 ? <Empty>No events.</Empty> : (
        <table className="t">
          <thead><tr><th>When</th><th>Event</th><th>By</th><th>Details</th></tr></thead>
          <tbody>{events.map((e) => (
            <tr key={e.id}>
              <td className="nowrap">{fmtTime(e.at)}</td>
              <td><strong>{e.type}</strong><small className="muted block">{e.subjectType} {e.subjectId.slice(-8)}</small></td>
              <td>{e.actor}{e.actorType === "agent" ? <Badge tone="info">agent</Badge> : null}</td>
              <td className="mono small">{summarize(e.data)}<small className="muted block">request {e.requestId.slice(-10)}</small></td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </Card>
  );
}

function summarize(data: Record<string, unknown> | undefined) {
  if (!data) return "";
  return Object.entries(data).filter(([, v]) => v !== null && typeof v !== "object").slice(0, 5).map(([k, v]) => `${k}: ${String(v)}`).join(" · ");
}
