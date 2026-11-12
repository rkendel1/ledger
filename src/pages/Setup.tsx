import { useState } from "react";
import { api, Card, Field, useMutation, useRun } from "../lib";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function Setup({ canSetUp }: { canSetUp: boolean }) {
  const setup = useMutation(api.org.setup);
  const { run, busy } = useRun();
  const [legalName, setLegalName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [fyStart, setFyStart] = useState(1);
  const [tax, setTax] = useState("");
  if (!canSetUp) {
    return <Card title="Books not set up yet"><p>An owner or administrator of this organization sets up its books. Ask them to finish setup.</p></Card>;
  }
  const taxBp = tax.trim() === "" ? undefined : Math.round(Number(tax) * 100);
  return (
    <Card title="Set up your books" className="setup">
      <p className="sub">Ledger creates a starting chart of accounts for a small services business. You can rename, add or deactivate accounts afterwards.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => setup({ legalName, baseCurrency: currency, fiscalYearStartMonth: fyStart, ...(taxBp ? { salesTaxRateBp: taxBp } : {}) }), "Books set up");
        }}
      >
        <Field label="Legal name"><input required value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="Boundry LLC" /></Field>
        <div className="row">
          <Field label="Base currency" hint="Fixed once set up. Ledger records in one currency.">
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>{["USD", "EUR", "GBP", "CAD", "AUD"].map((c) => <option key={c}>{c}</option>)}</select>
          </Field>
          <Field label="Fiscal year starts">
            <select value={fyStart} onChange={(e) => setFyStart(Number(e.target.value))}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
          </Field>
          <Field label="Sales tax rate (%)" hint="Optional">
            <input inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} placeholder="8.25" />
          </Field>
        </div>
        <button className="primary" disabled={busy || !legalName.trim() || (taxBp !== undefined && Number.isNaN(taxBp))}>Create books</button>
      </form>
    </Card>
  );
}
