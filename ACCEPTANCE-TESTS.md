# Acceptance tests

`npm test` runs 34 tests (`tests/*.test.ts`), each against a fresh FeltDB instance with a real
organization whose members joined through real FeltKit invitations. Last run (2026-11-12, vendored
FeltKit `66e4a11`): **34 passed, 0 failed**. `npm run test:artifact` builds the AppBoundry artifact and
runs Ledger's core workflows in two organizations inside it (1 test, passed).
`scripts/appboundry-acceptance.mts` runs Ledger on AppBoundry's own host in production mode over HTTP:
10 checks passed (`evidence/appboundry-acceptance.txt`).
Most scenarios end with `assertIntegrity`, which recomputes every ledger invariant from stored records.

| Requirement | Test | Status |
|---|---|---|
| **Accounting invariants** | | |
| Every posted entry balances | m0 "posting…", m0 property test, `integrity:check` after scenarios | Pass |
| Account balances = sum of posted entries | m0 property test (60 random entries, seeded) | Pass |
| Trial balance debits = credits | m0 property, m3 known-answer | Pass |
| Balance sheet A = L + E | m0 opening balances, m0 property, m3 (incl. next fiscal year) | Pass |
| Reversals preserve history | m0 reversal (original `__version` unchanged) | Pass |
| Drafts do not affect reports | m0 drafts, m3 (a 9,999.99 draft is absent everywhere) | Pass |
| Closed periods reject postings | m0 closed periods; m0 concurrency (close racing postings, commit revisions) | Pass |
| **Business workflows** | | |
| Create and issue an invoice | m1 invoice | Pass |
| Partial and full payment | m1 payments | Pass |
| Vendor bill: create, approve, post, pay | m1 bills | Pass |
| Import bank transactions; detect duplicates | m2 import | Pass |
| Match bank transactions | m2 matching/reconciliation; m4 rules | Pass |
| Complete reconciliation | m2 | Pass |
| Attach and retrieve receipts | m1 expenses (bytes identical, also after restart) | Pass |
| Generate financial reports | m3 (hand-computed answers) | Pass |
| Chart data equals the ledger | m3 "monthly trends …" (known answers; sums equal the P&L and the cash flow's actual cash change) | Pass |
| Vendored Stack UI unmodified | vendor.test.ts (every file against SHA256SUMS) | Pass |
| **Security** | | |
| Cross-tenant access rejected | m1 tenant isolation (reads, writes, payments, journal, receipts, non-member) | Pass |
| Unauthorized journal posting | m0 drafts (bookkeeper cannot post) | Pass |
| Unauthorized invoice issuance | m1 invoice (reviewer, agent) | Pass |
| Unauthorized expense modification | m1 expenses (reviewer upload; edit after approval) | Pass |
| Unauthorized period closure | m0 closed periods (bookkeeper, reviewer) | Pass |
| Unauthorized agent execution | m4 (assistant role; agent wrongly given bookkeeper role) | Pass |
| File access across organizations | m1 tenant isolation (read, link, attach a foreign file id); m1 "a person in two organizations cannot move a receipt" (Ledger's own file-organization check removed; the platform's is proven in FeltKit's G-04 tests) | Pass |
| Modifying posted records | m0 drafts (edit/delete posted), m1 (edit issued invoice, reverse a document's entry directly) | Pass |
| **Reliability** | | |
| Retries without duplicate effects | m0 idempotency (journal), m1 payments (payment key), m2 (re-import) | Pass |
| Concurrent posting | m0 concurrency (12 parallel), m1 concurrent over-payment | Pass |
| Consistency after failures | Refused postings consume no numbers (m0); stale proposal approval writes nothing (m4) | Pass |
| Recover from interrupted workflows | Only `t.restart()` durability (m1 receipts). No crash-injection test. | **Not tested** |
| **Agentic** | | |
| Proposals reviewable, decided by a person, with evidence | m4 approve/separation of duties | Pass |
| Deterministic rules, no duplicates, stale safety | m4 rules | Pass |
| Review queue items | m4 queue | Pass |
| Works with no AI service | Whole suite (no model configured) | Pass |
| Rules run in the background, in the importer's organization; refused once they leave | m4 "background job" (fails on published FeltKit 0.3.25) | Pass |
| **Platform** | | |
| Artifact builds and loads | tests-artifact | Pass |
| Organizations on AppBoundry: create, provision, switch, isolation, removal | tests-artifact (reference host); scripts/appboundry-acceptance.mts (AppBoundry host, HTTP, production) | Pass |
| Core workflows on AppBoundry: setup, invoice, payment, receipt, import, categorize, journal, reports, integrity | tests-artifact; appboundry-acceptance (invoice, payment, receipt, import + background scan, reports, integrity) | Pass |
| Backend code portable to the artifact (no Buffer, no Web Crypto) | base64.test.ts; tests-artifact | Pass |
| Vendored FeltKit is the recorded build | vendor.test.ts | Pass |

## Manual verification

The UI was driven with Playwright against `feltkit dev`: sign in as a development user, create an
organization, set up books, add a bank account, create/issue/pay an invoice, import a CSV, categorize and
match transactions, and open every section (desktop and 390 px phone width). No page errors were
raised. This is not an automated test.

## Not done

Performance/load testing, crash-injection recovery testing, a security audit beyond the tests above,
HTTP/MCP-level tests of the published capabilities on the FeltKit server, deployment, and the
real-world Boundry trial (M5). On AppBoundry: sign-up and invitations (not served there), the browser
UI (only the HTTP API was exercised), and Ledger's AppPort/MCP capabilities.
