# Architecture

Ledger is one FeltKit application: a `feltkit/` backend (collections, queries, mutations, capabilities)
and a `src/` React frontend, served together by `feltkit dev` / `feltkit start`, with one FeltDB instance
per environment. There is no other service, database, queue or sidecar. The same backend also builds into
an AppBoundry artifact (`feltkit build --target appboundry` → `ledger.app`) and runs there with its
organizations (tenancy@1); see "Runtimes" below.

```
Browser (src/)  ──HTTP──▶  FeltKit runtime  ──▶  FeltDB (the only state)
Agents          ──AppPort / MCP──▶   │                ▲
                                     └── AppPort Services (Files, Notifications, Jobs) on the same instance
```

## Organizations and authority

- An organization is a FeltKit **tenant** (`auth.tenant`, named "organization"). Every financial collection
  is `{ tenant: true }`: FeltKit stamps the caller's live organization on inserts and limits reads and
  writes to it. No function accepts an organization id.
- Roles (highest first): `owner`, `admin`, `accountant`, `bookkeeper`, `reviewer`, `assistant` (an agent).
  Each maps to permission strings in `feltkit/app.ts`; FeltKit checks `access` before every handler.
- Separation of duties: bookkeepers record (invoices, bills, expenses, payments, bank categorization,
  journal drafts); accountants post manual journals, reverse, approve bills and expenses, reconcile and
  close periods.
- **People only for financial execution.** `requirePerson()` runs in every function that changes the
  books and in the posting engine itself. Agents propose (`review:propose`); a person approves.
  FeltKit now enforces `approval: "required"` on AppBoundry too (G-03, closed in the platform); Ledger
  keeps `requirePerson()` because it is also the rule inside the posting engine, which no flag on a
  function covers, and because it is tested on both runtimes (MIGRATION.md).
- **The organization travels with all work.** Background jobs run in the organization they were queued
  in, as the person who queued them, through their live membership (G-01); Files belong to the
  organization they were uploaded in (G-04); a member removed is refused on their next request, job or
  recovered effect. All of this is FeltKit's, not Ledger's.

## The ledger

| Collection | Role |
|---|---|
| `journalEntries` | Entry headers. Drafts hold `draftLines`; posting assigns a gapless number from `ctx.db.sequence("journal:<org>")`. Posted headers are never updated. |
| `ledgerLines` | Posted debit/credit lines, written only by `postEntry` in the posting transaction. **The authoritative ledger.** |
| `audit` | `app.auditTrail`: an event for every financial change, in the same transaction, with actor, actor type and request id. |
| `periodEvents` + `orgSettings.closedThrough` | Closed-period boundary and its append-only history. |

`postEntry` (`feltkit/_ledger.ts`) enforces: two or more lines; non-negative integer minor units; each line
one-sided; debits = credits > 0; accounts exist in the organization and are active; date after
`closedThrough`; only document workflows touch the Accounts Receivable / Payable control accounts.
Reversal (`reverseEntry`) posts a mirrored entry linked by `reversalOf`; a unique constraint on
`(tenantId, reversalOf)` makes a second reversal impossible even concurrently.

Concurrency: a mutation's reads are fenced by FeltDB. Posting reads the organization's settings, so a
period close and a posting into that period cannot both commit (tested with commit revisions). Payments
read the document's allocations, so concurrent payments cannot over-settle it.

Money is `s.integer()` minor units everywhere. Invoice line amounts are `round_half_up(qty_milli × price / 1000)`;
tax is computed per line in basis points. No float is ever stored or summed.

## Documents and derived state

Invoices (`draft → issued → void`), credit notes, bills (`draft → approved → posted → void`), payments,
expenses (`draft → approved | rejected`). Paid / partially paid / overdue are **derived** from
`allocations` and dates (`feltkit/_documents.ts`), never stored. Payments keep an immutable copy of what
they applied (`applied`) as evidence; `allocations` is the live settlement and is removed only when a
payment is voided (by reversal).

## Banking

`importStatement` parses CSV exactly (`feltkit/_csv.ts`), stores the file in the Files service, and records
every row's fate on the `statementImports` record: imported, duplicate (with the transaction it
duplicates), or rejected (with the reason). Fingerprint = date | amount | normalized payee | occurrence in
file, unique per bank account, so identical rows within one statement stay distinct and re-imports collide.

A bank transaction is matched when ledger lines on its bank account sum to its amount; `bankMatches` holds
each cleared line once (unique). Categorizing posts a (possibly split) entry and matches its bank line.
Unmatching a categorized transaction **reverses** its entry. Excluding keeps the transaction with a reason.

Reconciliation sessions compute live: statement check (opening + transactions = closing), unmatched
transactions, outstanding book items, difference. Completion requires zero difference and nothing
unmatched; it stamps the transactions and stores a result snapshot; those transactions can no longer be
unmatched.

## Reports

`feltkit/reports.ts` computes every report from posted `ledgerLines` on request: P&L, balance sheet (with
prior-year retained earnings and current-year earnings computed from the fiscal year start, so it
balances without closing entries), indirect cash flow (checked against the actual change in cash),
trial balance, general ledger, account histories, AR/AP aging, and a deterministic "what changed".
`integrity:check` recomputes the invariants and also checks AR/AP control accounts against open documents.

Report shapes (all amounts in minor units) are the return types of `trialBalanceData`, `profitAndLossData`,
`balanceSheetData`, `cashFlowData`, `arAgingData`, `apAgingData`, `explainChangeData` and `integrityData`.

## Agentic bookkeeping

- **Read**: report and queue capabilities (`reports.*`, `review.queue`, `proposals.list`, `ledger.integrity`,
  `accounts.list`).
- **Propose**: `proposals.create` (agents) and `review.scan` (Ledger's rules: match a recorded payment,
  repeat a payee's past single-account categorization, apply a vendor's default account). Rule proposals
  are attributed to `ledger-rules`, with who triggered them in the evidence. After a statement import,
  the scan runs as a background job (`review.scan` → `review:scanJob`), queued after the import commits;
  `review:scan` stays callable on demand.
- **Approve**: `review:approve` — a person, not the proposer, holding `proposals.decide` **and** the action's
  own permission. Execution runs through the same functions as direct actions, in the approver's
  transaction; the entry carries `proposalId` and `approvedBy`. A stale proposal fails as a whole.
  A direct action on a transaction supersedes its open proposals.
- **Review queue** (`review:queue`): pending proposals, possible duplicate bank transactions, unusual
  amounts (> 3× median per payee / per expense account), missing receipts, approvals waiting, overdue
  invoices and bills, accounts not reconciled in 45 days.

No model is called anywhere. The Intelligence service is not enabled.

Ledger's proposals are its own tenant-scoped records (evidence, separation of duties, execution in the
approver's transaction), not FeltKit's agent tasks. FeltKit's tasks are now scoped to the organization
too (G-02), so either would be safe; Ledger keeps its own because its proposals carry accounting
evidence and rules that are Ledger's business logic, not a platform workaround.

## Runtimes

| | FeltKit server (`feltkit start`) | AppBoundry (`ledger.app`) |
|---|---|---|
| Sign-in | Built-in accounts (sign-up, e-mail) | Operator-issued sessions (`appboundry admin users add`, `sessions issue`); the host must be started with `--accounts operator-sessions` because Ledger declares `auth.accounts` |
| Organizations | Create, invite by e-mail, switch | Create, switch, members and roles over the same `/api/tenants/*` routes; members are provisioned by an operator (`appboundry admin tenants provision`), not invited |
| Books, reports, receipts, banking, review | Yes | Yes, same code (`tests-artifact/`, `scripts/appboundry-acceptance.mts`) |
| Background review scan | Yes | Yes (AppBoundry's job worker) |
| Agents | Propose via AppPort/MCP; FeltKit agent lifecycle available | Propose via AppPort/MCP; approval-required functions refused to agents (no lifecycle in an artifact) |

Backend code must stay portable to the artifact's guest: no Node APIs (`Buffer`, `node:*`) and no Web
Crypto. Ledger uses `feltkit/_base64.ts` and FeltKit's `sha256Hex` for that.

## Frontend

Charts are Stack UI components (`@stack-ui/react` 0.9.0, vendored in `vendor/stack-ui`): Ledger computes every
figure (`reports:trends`, `reports:profitAndLoss`, `accounts:history`) in integer minor units and passes them with a
currency format (`divisor: 100`); the components only present them. Ledger contains no chart rendering code.

React 19 + Vite, hash routing, FeltKit live queries (`useQuery` re-runs when the data it read changes).
Sign-in, organization creation/switching and member management are FeltKit's own components. Controls
are hidden when the caller lacks a permission (`org:me` returns the server's permission list); the server
enforces regardless.
