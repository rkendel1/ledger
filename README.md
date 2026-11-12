# Ledger

Small-business double-entry accounting, built on [FeltKit](https://www.npmjs.com/package/@feltdb/feltkit).

Ledger keeps a real general ledger for owner-operated businesses, consultants and small agencies:
invoices and receivables, bills and payables, expenses with receipts, CSV bank imports, reconciliation,
and financial statements. Every reported number is computed from posted journal lines and links back
to them. Posted entries are never edited; corrections are reversals. Agents can read the books and
propose work; only people execute financial actions.

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
```

Sign in as a development user (Ada or Grace), create an organization, and set up its books. Ledger
creates a starting chart of accounts. Production uses FeltKit's built-in accounts (`auth.accounts`):
people sign up, create an organization, and invite members with a role.

```bash
npm test                 # 34 tests, each on a fresh FeltDB instance
npm run test:artifact    # build the AppBoundry artifact and run the core workflows in it
npx tsc --noEmit         # typecheck
npx feltkit build        # production build
npm start                # run the production build
```

## What it does

| Area | |
|---|---|
| Overview | Cash, receivables, payables, year-to-date results, monthly income/expense and cash-flow charts, expense mix, balance sparklines, review queue, bank status, recent entries — each linked to its records |
| Banking | Bank and card accounts, CSV import with duplicate detection, match / categorize / split / exclude, reconciliation |
| Transactions | Journal entries: drafts, posting, reversal, full history |
| Invoices | Customers, invoices with tax, payments, credit notes, void |
| Bills | Vendors, bill capture → approval → posting → payment |
| Expenses | Expenses with receipts (Files service), approval |
| Accounting | Chart of accounts, account histories, closed periods, opening balances, tax rates |
| Reports | P&L, balance sheet, cash flow, trial balance, general ledger, AR/AP aging, what changed |
| Activity | Review queue, proposals and decisions, audit trail |
| Settings | Organization, members and roles, integrity check, notifications |

Charts come from [Stack UI](https://github.com/rkendel1/stack-ui) 0.9.0, vendored unmodified in `vendor/stack-ui`
(checked by `tests/vendor.test.ts`).

## Documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — how the ledger, authority and agents work
- [IMPLEMENTATION.md](IMPLEMENTATION.md) — what exists, what does not, known limitations
- [ACCEPTANCE-TESTS.md](ACCEPTANCE-TESTS.md) — requirements mapped to tests and results
- [GAP-REGISTER.md](GAP-REGISTER.md) — FeltKit capabilities inspected, gaps found, and how each was closed
- [MIGRATION.md](MIGRATION.md) — moving to the remediated platform: what changed in Ledger and what remains

## Status

Milestones M0–M4 are implemented and tested. M5 (production readiness) is partial: no deployment,
load test, recovery test or real-world trial has been done.

Ledger runs on a FeltKit server and on AppBoundry with its organizations. The platform gaps Ledger
found (organizations in artifacts, jobs, files, agent tasks, approvals) were fixed in FeltKit and
AppBoundry, not worked around here; Ledger uses a vendored pre-release of FeltKit until those changes
are published (`vendor/feltkit`, [MIGRATION.md](MIGRATION.md)).
