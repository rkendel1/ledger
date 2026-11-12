import { useState } from "react";
import { AccountSelect, api, Card, Empty, Field, Loading, Modal, useCan, useMutation, useQuery, useRun } from "../lib";

export function ContactsPanel({ kind }: { kind: "customer" | "vendor" }) {
  const contacts = useQuery(api.contacts.list, { kind, includeInactive: true });
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const can = useCan();
  const plural = kind === "customer" ? "Customers" : "Vendors";
  return (
    <Card title={plural} actions={can("contacts.write") ? <button className="small" onClick={() => setEditing("new")}>Add {kind}</button> : null}>
      {!contacts ? <Loading /> : contacts.length === 0 ? <Empty>No {plural.toLowerCase()} yet.</Empty> : (
        <table className="t">
          <thead><tr><th>Name</th><th>Email</th><th>Terms</th><th /></tr></thead>
          <tbody>{contacts.map((c) => <tr key={c.id} className={c.active ? "" : "muted"}><td>{c.name}</td><td>{c.email ?? ""}</td><td>{c.paymentTermsDays} days</td><td className="num">{can("contacts.write") ? <button className="small" onClick={() => setEditing(c.id)}>Edit</button> : null}</td></tr>)}</tbody>
        </table>
      )}
      {editing ? <ContactForm kind={kind} contact={editing === "new" ? undefined : contacts?.find((c) => c.id === editing)} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

type Contact = NonNullable<ReturnType<typeof useQuery<typeof api.contacts.list>>>[number];

export function ContactForm({ kind, contact, onClose, onCreated }: { kind: "customer" | "vendor"; contact?: Contact; onClose: () => void; onCreated?: (id: string) => void }) {
  const create = useMutation(api.contacts.create);
  const update = useMutation(api.contacts.update);
  const { run, busy } = useRun();
  const [name, setName] = useState(contact?.name ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [terms, setTerms] = useState(String(contact?.paymentTermsDays ?? 30));
  const [account, setAccount] = useState(contact?.defaultAccountId ?? "");
  const [active, setActive] = useState(contact?.active ?? true);
  return (
    <Modal title={contact ? `Edit ${contact.name}` : `New ${kind}`} onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        const fields = { name, ...(email ? { email } : {}), paymentTermsDays: Number(terms), ...(account ? { defaultAccountId: account } : {}) };
        const r = contact ? await run(() => update({ id: contact.id, ...fields, active }), "Saved") : await run(() => create({ kind, ...fields }), "Added");
        if (r) {
          if (!contact && onCreated) onCreated(r as string);
          onClose();
        }
      }}>
        <Field label="Name"><input required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="row">
          <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Payment terms (days)"><input type="number" min={0} max={365} value={terms} onChange={(e) => setTerms(e.target.value)} /></Field>
        </div>
        {kind === "vendor" ? <Field label="Usual expense account" hint="Used for bills and to suggest categories for bank transactions."><AccountSelect value={account} onChange={setAccount} types={["expense", "asset"]} placeholder="None" /></Field> : null}
        {contact ? <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active</label> : null}
        <div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Save</button></div>
      </form>
    </Modal>
  );
}
