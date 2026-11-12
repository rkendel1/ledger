# Implementation status

What exists, how it was verified, and what does not exist yet. Platform findings are in GAP-REGISTER.md.

## Milestones

| Milestone | State | Notes |
|---|---|---|
| M0 Accounting foundation | Done | Organization, chart of accounts, drafts/posting/reversal, periods, opening balances, GL, integrity check, property and concurrency tests. |
| M1 Core business accounting | Done | Customers, vendors, invoices (tax, credit notes, void), payments (idempotent, voidable), bills (approval), expenses, receipts (Files). |
| M2 Banking | Done | CSV import, normalization, duplicate detection, match, split categorization, exclude, unmatch-by-reversal, reconciliation sessions. |
| M3 Reporting | Done | P&L, balance sheet, cash flow, trial balance, GL, account history, AR/AP aging, overview, audit view. |
| M4 Agentic bookkeeping | Done, deterministic | Proposals, approval with separation of duties, three rules, review queue, report-change explanation. No model. |
| M5 Production readiness | **Partial** | Node build verified. Runs on AppBoundry with organizations (reference host test and AppBoundry's own host over HTTP, production mode). FeltKit is a vendored pre-release (vendor/feltkit). No deployment, load test, recovery test, external security audit, or Boundry trial. |

## Layout

```
feltkit/app.ts            roles, tenancy, collections (the schema)
feltkit/_ledger.ts        posting engine and accounting rules
feltkit/_documents.ts     derived invoice/bill state and aging buckets
feltkit/_csv.ts           statement parsing (pure)
feltkit/_bank.ts, _contracts.ts   helpers
feltkit/<module>.ts       functions: org, accounts, journal, contacts, invoices, payments, bills,
                          expenses, banking, reconciliation, reports, overview, review, activity,
                          integrity, inbox
src/                      React UI (App shell, lib, pages/*)
tests/                    feltkit test suites (m0–m4) and helpers
tests-artifact/           AppBoundry artifact test
```

## Charts (stack-ui 0.9.0)

| Where | Chart | Data |
|---|---|---|
| Overview | Income and expenses by month (bar), net cash flow by month (area), expenses by category (donut, centre = P&L total), cash-account balance sparklines | `reports:trends` (last 12 months), `reports:profitAndLoss` (fiscal YTD) |
| Reports → Trends | Revenue, expenses and net income (line); month-end cash and bank (area) | `reports:trends` for the selected range |
| Reports → Profit & loss | Where the money went (donut) | `reports:profitAndLoss` |
| Accounting → account | Balance over time (step line) | `accounts:history` |

Each chart has loading and empty states and a data table. With no postings the charts say so; nothing is invented.

## Decisions worth knowing

- **Ledger lines are the only posted truth.** Drafts keep lines on the header; they never reach
  `ledgerLines`, so they cannot leak into reports.
- **Control accounts.** Only invoice/credit-note/payment workflows post to Accounts Receivable, and only
  bill/payment workflows to Accounts Payable. This keeps the subledgers equal to their documents
  (checked by `integrity:check`).
- **Derived, not stored:** invoice and bill payment status, balances, overdue.
- **No `approval: "required"`.** It was used, then removed in favour of Ledger's own `requirePerson()`
  when it was not enforced in artifacts (G-03) and FeltKit's proposals were not organization-aware (G-02).
  Both are fixed in the platform; Ledger still relies on `requirePerson()` (MIGRATION.md says why).
- **The review scan is a background job** after each import (G-01, fixed in FeltKit), and on demand.
- **Rule proposals belong to `ledger-rules`**, so the person who ran the rules may approve them.

## Known limitations

- Single currency per organization (G-13). No payroll, inventory, tax filing, consolidation.
- No unapplied customer credit or prepayments: a payment must be fully applied to documents.
- Bills have no tax lines of their own (enter tax as an expense line).
- Payments made by credit card are recorded against the card account; card statements use the
  "charges are positive" import option (inverts signs).
- Reports scan all of an organization's ledger lines per request (G-12); not load-tested.
- Report capability output contracts are loosely typed (G-11).
- Receipts cannot be removed once attached (by design, evidence is preserved), and are limited to 10 MB.
- The UI uses browser `prompt()`/`confirm()` for reasons on void/reverse/reject.
- Studio, MCP and the AppPort HTTP surface were not exercised by Ledger's tests.
- Charts were checked by hand in the browser (desktop, 390px, light theme) on test postings; Ledger has no automated browser test of its pages. The chart components themselves are tested in stack-ui.
- Browser receipt upload (`expenses:uploadLink` → `client.uploadFile` → `expenses:attach`) was not exercised; server-side upload (`expenses:upload`) is tested.
- On AppBoundry, people cannot sign up or be invited by e-mail (no accounts@1): an operator issues sessions and provisions members.
- FeltKit is a vendored, unpublished build (`vendor/feltkit`, reporting version 0.3.25). Replace it with a published version when one exists.

## Verification commands

```bash
npm install
npx tsc --noEmit                 # typecheck backend, UI and tests
npm test                         # 34 tests against fresh FeltDB instances
npx feltkit build                # Node build: bundle, schema contract, frontend, secret scan
npm run test:artifact            # AppBoundry artifact build + core workflows in organizations
# Ledger on AppBoundry's own host (needs an AppBoundry checkout; see the script's header):
APPBOUNDRY_HOST=<appboundry>/packages/appboundry-host/dist/index.js npx tsx scripts/appboundry-acceptance.mts ledger.app
npm run dev                      # http://localhost:3000, sign in as a development user
```
