import { useMemo, useState } from "react";
import { AccountSelect, api, Badge, Card, Empty, Field, fmtDate, Link, Loading, Modal, Money, MoneyInput, Page, parseMoney, Status, Tabs, today, useCan, useMutation, useQuery, useRun, useToast } from "../lib";

export function Banking({ path }: { path: string[] }) {
  const accounts = useQuery(api.banking.listAccounts, {});
  const [adding, setAdding] = useState(false);
  const can = useCan();
  if (!accounts) return <Loading />;
  const selected = path[0] ? accounts.find((a) => a.id === path[0]) : accounts[0];
  return (
    <Page title="Banking" subtitle="Import statements, explain every transaction, and reconcile." actions={can("accounts.write") ? <button onClick={() => setAdding(true)}>Add bank account</button> : null}>
      {accounts.length === 0 ? <Card><Empty>No bank accounts yet. Add one to import a CSV statement.</Empty></Card> : (
        <>
          <div className="pills">
            {accounts.map((a) => (
              <a key={a.id} href={`#/banking/${a.id}`} className={`pill${selected?.id === a.id ? " on" : ""}`}>
                <strong>{a.name}</strong>
                <span><Money minor={a.bookBalanceMinor} /> in books</span>
                {a.unmatchedCount ? <Badge tone="warn">{a.unmatchedCount} to review</Badge> : <Badge tone="ok">up to date</Badge>}
              </a>
            ))}
          </div>
          {selected ? <BankAccount key={selected.id} account={selected} /> : null}
        </>
      )}
      {adding ? <AddAccount onClose={() => setAdding(false)} /> : null}
    </Page>
  );
}

type Account = NonNullable<ReturnType<typeof useQuery<typeof api.banking.listAccounts>>>[number];

function AddAccount({ onClose }: { onClose: () => void }) {
  const create = useMutation(api.banking.createAccount);
  const { run, busy } = useRun();
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [number, setNumber] = useState("");
  const [kind, setKind] = useState<"bank" | "credit_card">("bank");
  const [last4, setLast4] = useState("");
  return (
    <Modal title="Add a bank account" onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        const r = await run(() => create({ name, ...(accountId ? { accountId } : { newAccountNumber: number, kind }), ...(last4 ? { last4 } : {}) }), "Bank account added");
        if (r) onClose();
      }}>
        <Field label="Name"><input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Chase Checking" /></Field>
        <Field label="Ledger account" hint="Link an existing cash, bank or card account, or leave empty to create one.">
          <AccountSelect value={accountId} onChange={setAccountId} subtypes={["bank", "cash", "credit_card"]} placeholder="Create a new ledger account" />
        </Field>
        {!accountId ? (
          <div className="row">
            <Field label="New account number"><input required pattern="[0-9]{3,8}" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="1020" /></Field>
            <Field label="Kind"><select value={kind} onChange={(e) => setKind(e.target.value as "bank" | "credit_card")}><option value="bank">Bank account</option><option value="credit_card">Credit card</option></select></Field>
          </div>
        ) : null}
        <Field label="Last 4 digits" hint="Optional"><input pattern="[0-9]{4}" value={last4} onChange={(e) => setLast4(e.target.value)} /></Field>
        <div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Add</button></div>
      </form>
    </Modal>
  );
}

function BankAccount({ account }: { account: Account }) {
  const [tab, setTab] = useState<"review" | "all" | "reconcile" | "imports">("review");
  return (
    <>
      <Tabs value={tab} onChange={setTab} tabs={[["review", `To review (${account.unmatchedCount})`], ["all", "All transactions"], ["reconcile", "Reconcile"], ["imports", "Imports"]]} />
      {tab === "review" ? <Transactions account={account} status="unmatched" /> : null}
      {tab === "all" ? <Transactions account={account} /> : null}
      {tab === "reconcile" ? <Reconcile account={account} /> : null}
      {tab === "imports" ? <Imports account={account} /> : null}
    </>
  );
}

function ImportButton({ account }: { account: Account }) {
  const importStatement = useMutation(api.banking.importStatement);
  const { run, busy } = useRun();
  const toast = useToast();
  const [invert, setInvert] = useState(account.ledgerType === "liability");
  return (
    <span className="import">
      <label className="button">
        {busy ? "Importing…" : "Import CSV"}
        <input type="file" accept=".csv,text/csv" hidden disabled={busy} onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          const csv = await file.text();
          const r = await run(() => importStatement({ bankAccountId: account.id, fileName: file.name, csv, invertSigns: invert }));
          if (r) {
            // Suggestions for the new lines are made by a background job (review.scan) and appear as it finishes.
            toast("ok", r.replayed ? "This file was already imported." : `Imported ${r.imported}. ${r.duplicates} duplicate${r.duplicates === 1 ? "" : "s"} skipped and ${r.rejected} row${r.rejected === 1 ? "" : "s"} rejected — both are listed under Imports. Suggestions follow shortly.`);
          }
        }} />
      </label>
      <label className="check"><input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} /> charges are positive</label>
    </span>
  );
}

function Transactions({ account, status }: { account: Account; status?: "unmatched" }) {
  const toast = useToast();
  const txns = useQuery(api.banking.transactions, { bankAccountId: account.id, ...(status ? { status } : {}) });
  const proposals = useQuery(api.review.list, { status: "pending" });
  const scan = useMutation(api.review.scan);
  const can = useCan();
  const { run, busy } = useRun();
  const [open, setOpen] = useState<string | null>(null);
  const byTxn = useMemo(() => new Map((proposals ?? []).filter((p) => p.subjectKey.startsWith("bank:")).map((p) => [p.subjectKey.slice(5), p])), [proposals]);
  if (!txns) return <Loading />;
  return (
    <Card
      title={status ? "Transactions to review" : "All transactions"}
      actions={<span className="actions">
        {can("proposals.create") ? <button disabled={busy} onClick={async () => { const r = await run(() => scan({})); if (r) toast("ok", r.proposed ? `${r.proposed} new suggestion${r.proposed === 1 ? "" : "s"}` : "No new suggestions"); }}>Suggest</button> : null}
        {can("banking.import") ? <ImportButton account={account} /> : null}
      </span>}
    >
      {txns.length === 0 ? <Empty>{status ? "Every imported transaction is explained." : "No transactions imported yet."}</Empty> : (
        <table className="t">
          <thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th><th>Status</th><th>Suggestion</th><th /></tr></thead>
          <tbody>
            {txns.map((t) => {
              const p = byTxn.get(t.id);
              return (
                <tr key={t.id} className={open === t.id ? "selected" : ""}>
                  <td>{fmtDate(t.date)}</td>
                  <td>{t.description}{t.excludedReason ? <small className="muted"> — {t.excludedReason}</small> : null}</td>
                  <td className="num"><Money minor={t.amountMinor} sign /></td>
                  <td><Status value={t.status} />{t.reconciliationId ? <Badge tone="ok">reconciled</Badge> : null}</td>
                  <td>{p ? <ProposalInline proposal={p} /> : t.journalEntryId ? <Link to={`transactions/${t.journalEntryId}`}>entry</Link> : null}</td>
                  <td className="num"><button className="small" onClick={() => setOpen(t.id)}>{t.status === "unmatched" ? "Explain" : "Details"}</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {open ? <Explain txn={txns.find((t) => t.id === open)!} account={account} onClose={() => setOpen(null)} /> : null}
    </Card>
  );
}

type Proposal = NonNullable<ReturnType<typeof useQuery<typeof api.review.list>>>[number];

export function ProposalInline({ proposal }: { proposal: Proposal }) {
  const approve = useMutation(api.review.approve);
  const reject = useMutation(api.review.reject);
  const me = useQuery(api.org.me, {});
  const can = useCan();
  const { run, busy } = useRun();
  const own = me?.id === proposal.proposedBy;
  return (
    <div className="proposal">
      <span title={proposal.rationale}>{proposal.summary}</span>
      <small className="muted">{proposal.source.startsWith("rules:") ? `Ledger rule (${proposal.source.slice(6)})` : `from ${proposal.proposedBy}`} · {proposal.rationale}</small>
      {can("proposals.decide") && !own ? (
        <span className="actions">
          <button className="small primary" disabled={busy} onClick={() => run(() => approve({ id: proposal.id }), "Approved and posted")}>Approve</button>
          <button className="small" disabled={busy} onClick={() => { const reason = prompt("Why reject this suggestion?"); if (reason) void run(() => reject({ id: proposal.id, reason }), "Rejected"); }}>Reject</button>
        </span>
      ) : own ? <small className="muted">Your proposal: someone else approves it.</small> : null}
    </div>
  );
}

type Txn = NonNullable<ReturnType<typeof useQuery<typeof api.banking.transactions>>>[number];

function Explain({ txn, account, onClose }: { txn: Txn; account: Account; onClose: () => void }) {
  const candidates = useQuery(api.banking.candidates, txn.status === "unmatched" ? { bankTransactionId: txn.id } : "skip");
  const match = useMutation(api.banking.match);
  const categorize = useMutation(api.banking.categorize);
  const exclude = useMutation(api.banking.exclude);
  const include = useMutation(api.banking.include);
  const unmatch = useMutation(api.banking.unmatch);
  const can = useCan();
  const { run, busy } = useRun();
  const total = Math.abs(txn.amountMinor);
  const [splits, setSplits] = useState<Array<{ accountId: string; amount: string; memo: string }>>([{ accountId: "", amount: (total / 100).toFixed(2), memo: "" }]);
  const parsed = splits.map((s) => parseMoney(s.amount));
  const sum = parsed.reduce<number>((t, v) => t + (v ?? 0), 0);
  const valid = splits.every((s, i) => s.accountId && parsed[i] !== null && parsed[i]! > 0) && sum === total;
  return (
    <Modal title={txn.description} onClose={onClose} wide>
      <p className="lead"><Money minor={txn.amountMinor} sign /> on {fmtDate(txn.date)} · {account.name} · <Status value={txn.status} /></p>
      {txn.status === "unmatched" ? (
        <>
          <h3>Match to what's already in the books</h3>
          {candidates === undefined ? <Loading /> : candidates.length === 0 ? <p className="muted">No recorded payment, expense or entry on {account.ledgerName} has this amount within 10 days.</p> : (
            <table className="t"><tbody>
              {candidates.map((c) => (
                <tr key={c.lineId}><td>#{c.entryNumber}</td><td>{fmtDate(c.date)}</td><td>{c.description}</td><td className="muted">{c.dayGap} day{c.dayGap === 1 ? "" : "s"} apart</td>
                  <td className="num">{can("banking.match") ? <button className="small primary" disabled={busy} onClick={async () => { if (await run(() => match({ bankTransactionId: txn.id, ledgerLineIds: [c.lineId] }), "Matched")) onClose(); }}>Match</button> : null}</td></tr>
              ))}
            </tbody></table>
          )}
          {can("banking.categorize") ? (
            <>
              <h3>Or categorize it {splits.length > 1 ? `(split ${splits.length} ways)` : ""}</h3>
              <p className="muted small">{txn.amountMinor > 0 ? "Money in: the bank is debited and each line below is credited." : "Money out: each line below is debited and the bank is credited."}</p>
              {splits.map((s, i) => (
                <div className="split" key={i}>
                  <AccountSelect value={s.accountId} onChange={(v) => setSplits(splits.map((x, k) => (k === i ? { ...x, accountId: v } : x)))} />
                  <MoneyInput value={s.amount} onChange={(v) => setSplits(splits.map((x, k) => (k === i ? { ...x, amount: v } : x)))} />
                  <input placeholder="Memo" value={s.memo} onChange={(e) => setSplits(splits.map((x, k) => (k === i ? { ...x, memo: e.target.value } : x)))} />
                  {splits.length > 1 ? <button className="icon" aria-label="Remove line" onClick={() => setSplits(splits.filter((_, k) => k !== i))}>×</button> : null}
                </div>
              ))}
              <div className="split-foot">
                <button className="small" onClick={() => setSplits([...splits, { accountId: "", amount: "", memo: "" }])}>Add split</button>
                <span className={sum === total ? "ok" : "warn"}>Allocated <Money minor={sum} /> of <Money minor={total} /></span>
                <button className="primary" disabled={!valid || busy} onClick={async () => {
                  const r = await run(() => categorize({ bankTransactionId: txn.id, splits: splits.map((s, i) => ({ accountId: s.accountId, amountMinor: parsed[i]!, ...(s.memo ? { memo: s.memo } : {}) })) }), "Categorized and posted");
                  if (r) onClose();
                }}>Post</button>
              </div>
            </>
          ) : null}
          {can("banking.match") ? <p><button className="small" onClick={() => { const reason = prompt("Why set this transaction aside? It stays listed."); if (reason) void run(() => exclude({ bankTransactionId: txn.id, reason }), "Excluded").then((r) => r && onClose()); }}>Exclude…</button></p> : null}
        </>
      ) : (
        <>
          {txn.journalEntryId ? <p>Explained by <Link to={`transactions/${txn.journalEntryId}`}>its categorization entry</Link>.</p> : <p>Matched to {txn.matchedLineIds.length} ledger line{txn.matchedLineIds.length === 1 ? "" : "s"}{txn.matchedBy ? ` by ${txn.matchedBy}` : ""}.</p>}
          {txn.status === "matched" && !txn.reconciliationId && can("banking.match") ? <button onClick={() => { const reason = prompt("Why unmatch? A categorization entry will be reversed, not deleted."); if (reason) void run(() => unmatch({ bankTransactionId: txn.id, reason }), "Unmatched").then((r) => r && onClose()); }}>Unmatch…</button> : null}
          {txn.status === "excluded" && can("banking.match") ? <button onClick={() => run(() => include({ bankTransactionId: txn.id }), "Back in review").then((r) => r && onClose())}>Include again</button> : null}
          {txn.reconciliationId ? <p className="muted">Part of a completed reconciliation; it can no longer change.</p> : null}
        </>
      )}
    </Modal>
  );
}

function Reconcile({ account }: { account: Account }) {
  const recs = useQuery(api.reconciliation.list, { bankAccountId: account.id });
  const start = useMutation(api.reconciliation.start);
  const can = useCan();
  const { run, busy } = useRun();
  const [end, setEnd] = useState(today());
  const [closing, setClosing] = useState("");
  const [opening, setOpening] = useState("");
  const [startDate, setStartDate] = useState("");
  if (!recs) return <Loading />;
  const current = recs.find((r) => r.status === "in_progress");
  const first = !recs.some((r) => r.status === "completed");
  return (
    <>
      {current ? <Workspace id={current.id} /> : can("banking.match") ? (
        <Card title="Start a reconciliation">
          <form className="row" onSubmit={(e) => {
            e.preventDefault();
            const c = parseMoney(closing);
            const o = parseMoney(opening);
            if (c === null || (first && (o === null || !startDate))) return;
            void run(() => start({ bankAccountId: account.id, statementEnd: end, closingBalanceMinor: c, ...(first ? { openingBalanceMinor: o!, statementStart: startDate } : {}) }));
          }}>
            {first ? <Field label="Statement starts"><input type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field> : null}
            {first ? <Field label="Opening balance"><MoneyInput value={opening} onChange={setOpening} /></Field> : null}
            <Field label="Statement ends"><input type="date" required value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
            <Field label="Closing balance"><MoneyInput value={closing} onChange={setClosing} /></Field>
            <button className="primary" disabled={busy}>Start</button>
          </form>
          {!first ? <p className="muted small">Opens at the last reconciled closing balance, the day after the last statement ended.</p> : null}
        </Card>
      ) : null}
      <Card title="History">
        {recs.filter((r) => r.status === "completed").length === 0 ? <Empty>No completed reconciliations.</Empty> : (
          <table className="t"><thead><tr><th>Statement</th><th className="num">Opening</th><th className="num">Closing</th><th>Completed</th><th /></tr></thead><tbody>
            {recs.filter((r) => r.status === "completed").map((r) => <tr key={r.id}><td>{fmtDate(r.statementStart)} – {fmtDate(r.statementEnd)}</td><td className="num"><Money minor={r.openingBalanceMinor} /></td><td className="num"><Money minor={r.closingBalanceMinor} /></td><td>{r.completedBy} · {r.result?.bankTransactionIds.length} transactions</td><td><Status value="completed" /></td></tr>)}
          </tbody></table>
        )}
      </Card>
    </>
  );
}

function Workspace({ id }: { id: string }) {
  const w = useQuery(api.reconciliation.get, { id });
  const complete = useMutation(api.reconciliation.complete);
  const cancel = useMutation(api.reconciliation.cancel);
  const can = useCan();
  const { run, busy } = useRun();
  if (!w) return <Loading />;
  const r = w.reconciliation;
  return (
    <Card title={`Reconciling ${fmtDate(r.statementStart)} – ${fmtDate(r.statementEnd)}`} actions={<span className="actions">
      {can("banking.match") ? <button className="small" onClick={() => confirm("Abandon this reconciliation? Nothing has been stamped yet.") && run(() => cancel({ id }))}>Cancel</button> : null}
      {can("banking.reconcile") ? <button className="primary" disabled={!w.canComplete || busy} onClick={() => run(() => complete({ id }), "Reconciled")}>Complete</button> : null}
    </span>}>
      <div className="recon">
        <div><span>Statement opening</span><Money minor={r.openingBalanceMinor} /></div>
        <div><span>+ Matched transactions</span><Money minor={w.clearedMinor - r.openingBalanceMinor} /></div>
        <div><span>= Cleared balance</span><Money minor={w.clearedMinor} /></div>
        <div><span>Statement closing</span><Money minor={r.closingBalanceMinor} /></div>
        <div className={w.differenceMinor === 0 ? "ok" : "bad"}><span>Difference</span><Money minor={w.differenceMinor} /></div>
        <div><span>Book balance</span><Money minor={w.bookBalanceMinor} /></div>
        <div><span>Outstanding items</span><Money minor={w.outstandingMinor} /></div>
      </div>
      {w.discrepancies.length ? <ul className="discrepancies">{w.discrepancies.map((d) => <li key={d}>{d}</li>)}</ul> : <p className="ok">The statement and the books agree.</p>}
      {w.unmatched.length ? (
        <>
          <h3>On the statement, not in the books ({w.unmatched.length})</h3>
          <table className="t"><tbody>{w.unmatched.map((t) => <tr key={t.id}><td>{fmtDate(t.date)}</td><td>{t.description}</td><td className="num"><Money minor={t.amountMinor} sign /></td></tr>)}</tbody></table>
          <p className="muted small">Explain them in the "To review" tab.</p>
        </>
      ) : null}
      {w.outstanding.length ? (
        <>
          <h3>In the books, not yet on a statement ({w.outstanding.length})</h3>
          <table className="t"><tbody>{w.outstanding.map((o) => <tr key={o.lineId}><td><Link to={`transactions/${o.entryId}`}>#{o.entryNumber}</Link></td><td>{fmtDate(o.date)}</td><td>{o.description}</td><td className="num"><Money minor={o.amountMinor} sign /></td></tr>)}</tbody></table>
        </>
      ) : null}
      {w.excluded.length ? <p className="muted small">{w.excluded.length} excluded transaction{w.excluded.length === 1 ? "" : "s"} in this period (kept with their reasons).</p> : null}
    </Card>
  );
}

function Imports({ account }: { account: Account }) {
  const imports = useQuery(api.banking.imports, { bankAccountId: account.id });
  if (!imports) return <Loading />;
  if (imports.length === 0) return <Card><Empty>No statements imported.</Empty></Card>;
  return (
    <>
      {imports.map((i) => (
        <Card key={i.id} title={`${i.fileName} · ${fmtDate(i.periodStart)} – ${fmtDate(i.periodEnd)}`} actions={<span className="muted small">by {i.importedBy} · sha256 {i.sha256.slice(0, 12)}…</span>}>
          <p>{i.rowCount} rows: {i.importedCount} imported, {i.duplicates.length} duplicates, {i.rejected.length} rejected.</p>
          {i.duplicates.length ? <><h3>Duplicates (already imported)</h3><table className="t"><tbody>{i.duplicates.map((d) => <tr key={d.row}><td>row {d.row}</td><td>{fmtDate(d.date)}</td><td>{d.description}</td><td className="num"><Money minor={d.amountMinor} sign /></td></tr>)}</tbody></table></> : null}
          {i.rejected.length ? <><h3>Rejected rows</h3><table className="t"><tbody>{i.rejected.map((d) => <tr key={d.row}><td>row {d.row}</td><td>{d.reason}</td><td className="mono">{d.raw}</td></tr>)}</tbody></table></> : null}
        </Card>
      ))}
    </>
  );
}
