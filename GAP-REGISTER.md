# Gap register

Gaps found while building Ledger on FeltKit 0.3.25 (`@feltdb/feltkit`, FeltDB 0.21.0, AppPort Services).
Each entry names the evidence that established it. "Recommended ownership" is where the fix belongs.

**Remediation (2026-11-12).** The platform gaps were then fixed where they belong, in FeltKit and
AppBoundry, each with a reproduction test that fails on the original code and passes on the fix, run on
both runtimes. See [Remediation](#remediation) below; the original entries are kept as found.

## Platform capability inventory

Inspected in the published packages (`node_modules/@feltdb/feltkit/dist`, `@appport/*`), the
`rkendel1/feltkit` repository (README, `docs/`, `examples/`, `packages/sdk/test`), and by running code.

| Capability | Status for Ledger | Evidence |
|---|---|---|
| Collections, schema contract, unique constraints, indexes | 1. Implemented and verified | All 28 tests; `feltkit build` "21 collection(s) compile to a FeltDB state contract" |
| Atomic mutations with read fencing (`CONFLICT` on concurrent change) | 1. Verified | `m0` concurrency test; `m1` concurrent over-payment test |
| `ctx.db.sequence` (gapless, per stream) | 1. Verified | Journal and invoice numbering; integrity check asserts gaplessness |
| `app.auditTrail` (transactional, per-subject seq, request id) | 1. Verified | `m3` audit test links an event to FeltKit's activity log entry |
| Tenancy (`auth.tenant`, `{ tenant: true }` collections) | 1. Verified on FeltKit's runtime | `m1` tenant isolation test; smoke test with two tenants |
| Roles → permissions, enforced on every interface | 1. Verified (in-process interface) | Every `FORBIDDEN` assertion in the suite |
| AppPort capabilities (22 published) | 2. Implemented, insufficiently tested by Ledger | `feltkit dev` reports "AppPort … (22 capabilities)"; not exercised over HTTP/MCP by Ledger's tests |
| Files service (`upload`, `get`, `read`, `uploadLink`, `link`) | 1. Verified for server-side upload/read; 2. `uploadLink` + browser `PUT` (the UI's upload path) is written against the documented API but was not exercised, by a test or the UI walkthrough | `m1` receipts tests (incl. after restart) |
| Notifications (`afterCommit.notifications.send`) | 1. Verified | `m1` bills test reads the accountant's inbox |
| Jobs (`afterCommit.jobs.enqueue`) | 4. Unusable for tenant data on 0.3.25; **1. Verified** on the remediated FeltKit (review scan job) | G-01 |
| FeltKit agent tasks / `approval: "required"` | 3. Partially usable on 0.3.25; organization-scoped and enforced in artifacts after remediation (Ledger keeps its own proposals) | G-02, G-03 |
| Intelligence (model decisions) | Not used | Ledger is deterministic; see ARCHITECTURE.md |
| AppBoundry artifact build | 1. Builds and loads; 5. blocked from serving Ledger on 0.3.25; **1. Verified** after remediation: core workflows in organizations on FeltKit's reference host and on AppBoundry's host over HTTP | G-05, `tests-artifact/artifact.test.ts`, `evidence/appboundry-acceptance.txt` |
| Studio / MCP developer workflows | Not exercised | Dashboard and MCP endpoint start with `feltkit dev`; no Ledger test drives them |
| Deployment (`feltkit deploy`) | Not exercised | `feltkit build` (Node target) succeeds; no deployment was performed |

## Gaps

| ID | Description | Evidence | Impact | Severity | Recommended ownership | Workaround in Ledger |
|---|---|---|---|---|---|---|
| G-01 | A job enqueued from a mutation that works in a tenant runs as the same principal **with no tenant**, and without the membership role's permissions. | Probe (removed after use): job handler logged `principal grace tenant null enqueued from tnt_…`; before granting `person` the jobs permissions the job failed `DENIED: AuthBoundry denied jobs.execute`. | Background processing cannot touch any organization's books. Spec item "background processing through Jobs" is not met. | High | FeltKit (carry the tenant into `afterCommit.jobs` and the services worker, as `app.agent` does for members) | The review rules run synchronously (`review:scan`, called by the UI after each import and on demand). |
| G-02 | FeltKit's agent tasks and proposals (`ctx.agent`, `feltkit_agent_propose`, Studio approvals) have no tenant awareness. | `grep -i tenant node_modules/@feltdb/feltkit/dist/runtime/agent.js` finds nothing. | An approval queue built on them would mix organizations, or run actions outside the proposer's organization. | High | FeltKit | Ledger keeps its own tenant-scoped `proposals` collection (`feltkit/review.ts`); approval executes in the approver's transaction. |
| G-03 | `approval: "required"` is not enforced inside an AppBoundry artifact. | `feltkit build --target appboundry`: "approval: "required" is enforced by FeltKit's agent lifecycle … which an artifact does not run: an agent or service could call the mutation directly." | Relying on it would leave financial mutations open to agents on AppBoundry. | Medium | FeltKit / AppBoundry | `requirePerson()` in every financial-execution handler and in the posting engine; the flag was removed (it also steered agents toward G-02's proposals). Tested in `m4` ("even if given a role that could"). |
| G-04 | The Files service is application-wide, not tenant-scoped. Any function holding `files.read` can read any file id. | `FileInfo` has no tenant; `runtime/services.js` scopes files by the application's services tenant only. | Without care, a receipt id from one organization could be read from another. | High | AppPort Services / FeltKit (tenant-scoped files) | Uploads carry `ledgerTenant` and subject in metadata the client cannot change; `attach` checks tenant and uploader before binding; receipts are read only through the tenant-scoped `receipts` collection. Tested in `m1` tenant isolation. |
| G-05 | AppBoundry sessions carry no tenant, and accounts/tenancy routes are not served by an artifact (FeltKit's own FK-GAP-013). | Build warnings; `tests-artifact/artifact.test.ts` shows `org.me` → `tenant: null` and `org.settings` → `FAILED_PRECONDITION`. | Ledger cannot run on AppBoundry today. | High | FeltKit / AppBoundry | None. Run with `feltkit start` / `feltkit deploy` (Node or container). |
| G-06 | No storage-level immutability: FeltDB will accept a patch or delete of a posted entry, ledger line or audit event from any code path that issues one (including Studio's development data editor and `ctx.unsafe.feltdb`). | `app.auditTrail` doc: "Append-only is the helper's contract"; README: Studio Data edits allowed in development. | Immutability rests on Ledger's code paths, not the database. | Medium | FeltDB (append-only / write-once collections) | No Ledger function updates a posted header, ledger line or audit event; `integrity:check` recomputes balances, numbering and mirrors and reports drift. |
| G-07 | Notifications belong to the person, not the organization. | `ctx.services.notifications.list` returns the caller's own notices across tenants. | A person in two organizations sees both organizations' notices in one inbox. | Low | AppPort Services | Notices carry only a title and a record id; opening one in the wrong organization finds nothing. |
| G-08 | A unique constraint on a tenant-scoped collection is global unless it names the tenant field, and it can name it only if the shape declares it. | Build error: `unique constraint names "tenantId", which the collection does not declare`. | Easy to create cross-organization uniqueness by accident (e.g. two organizations both wanting account 1000). | Medium | FeltKit (make uniques tenant-relative by default) | Every tenant collection declares `tenantId: s.optional(s.string())` and every unique includes it. |
| G-09 | ~~`ctx.db.patch` cannot remove a field (`undefined` is not stored).~~ **Wrong.** FeltKit removes a field patched to `undefined`, on its runtime (`runtime/data.ts` patch) and in an artifact (`appboundry/guest.ts`, `unset`). | Re-checked in the source during remediation; `m2` asserts the stale `journalEntryId` is gone after unmatching, with plain `patch`. | None. | — | — | `patchRemoving()` removed; plain `ctx.db.patch(…, { field: undefined })`. |
| G-10 | FeltKit's tenant screens say "Create a organization". | UI walkthrough. | Cosmetic. | Low | FeltKit | None. |
| G-11 | Report capabilities publish loose output contracts (`record<unknown>`). | `feltkit/_contracts.ts`. | Agents and other apps get no field-level contract for reports. | Low | Ledger | TypeScript callers are fully typed; shapes documented in ARCHITECTURE.md. |
| G-12 | Reports and the review queue read every ledger line of the organization on each request. | `reports.ts` `totalsByAccount`. | Fine for thousands of entries; untested beyond that. | Medium | Ledger (period balances or FeltDB aggregates) | None yet. No performance testing was done. |
| G-13 | Single currency only. | `expenses.ts` refuses a non-base currency. | Foreign-currency spend must be converted before entry. | Medium | Ledger | Clear refusal message. |
| G-14 | Opening receivables and payables can only be entered as documents, not as opening balances. | `setOpeningBalances` refuses AR/AP (control-account rule). | Migrating an existing business needs its open invoices and bills re-entered. | Low | Ledger | Enter them as invoices/bills dated before go-live (their revenue/expense then lands in that earlier period, i.e. prior-year earnings). |
| G-15 | No live bank connectivity. | By design for this version. | CSV import only. | — | Ledger (behind an explicit contract, later) | — |

## Visualization (charts)

Ledger needed revenue, expense, cash-flow, composition and balance charts. No Boundry platform package drew
charts (searched FeltKit, AppBoundry, AppPort, AppPort Services and stack-ui, 2026-11-12), so every application
would have chosen and wrapped its own library. This was solved in the platform, not in Ledger.

| ID | Description | Evidence | Status / ownership |
|---|---|---|---|
| V-01 | No shared data-visualization capability in the FeltKit UI ecosystem. | stack-ui 0.8.1 contract §5: "Not in the initial inventory: charts … product-owned until two products need the same one". | **Implemented in stack-ui 0.9.0** (`rkendel1/stack-ui` branch `claude/happy-fermat-wynpur`, decision D38, `docs/charts.md`): `LineChart`, `AreaChart`, `BarChart`, `StackedBarChart`, `DonutChart`, `Sparkline`, native SVG, no dependencies. Not yet tagged or published: the owner tags the release. |
| V-02 | Ledger is the only real consumer so far; stack-ui's rule wants two. | D38 records an owner-directed exception. | stack-ui. The next product dashboard (FeltKit Studio, FeltDB Studio) should adopt the charts. |
| V-03 | stack-ui 0.9.0 is not on npm; Ledger vendors it. | `npm view @stack-ui/core` shows 0.8.1; stack-ui docs/release.md prescribes vendoring with `file:` dependencies until publishing. | Ledger vendors `vendor/stack-ui` with `scripts/vendor-packages.mjs`; `tests/vendor.test.ts` checks every file against `SHA256SUMS`, which equals stack-ui's recorded `releases/0.9.0/packages.SHA256SUMS`. Switch to npm once published. |
| V-04 | `@stack-ui/core/html`, `/view` and `/dom` ship no TypeScript declarations (pre-existing). | stack-ui's packed-tarball consumer test failed on `@stack-ui/core/html` until it declared the module. | stack-ui. The new `@stack-ui/core/charts` entry point ships declarations. |
| V-05 | Ledger's own layout scrolled horizontally at phone width (32px). | Found while checking charts at 390px: the shell's grid column took the navigation's min-content width. | Fixed in Ledger (`minmax(0, 1fr)`). Not a chart defect. |
| V-06 | Ledger adopts only stack-ui's charts, tokens and core CSS, not its Shell or other components, so it does not pass stack-ui's application conformance check. | stack-ui docs/building-with-the-foundation.md. | Ledger. A full adoption is a separate change. |

Measured (non-blank lines): stack-ui chart subsystem 575 (core) + 48 (types) + 100 (CSS) + 142 (React binding and
types) + 42 (wiring) + 17 (tokens); tests 650; showcase 177; third-party runtime dependencies 0. Ledger's
visualization-specific UI code is 136 lines that pass ledger data to those components; the monthly figures are a
65-line Ledger query (`reports:trends`), tested against the P&L and cash-flow reports.

## Remediation

Done in the owning repositories, on branch `claude/happy-fermat-wynpur` of rkendel1/feltkit and
rkendel1/appboundry. "Reproduction" is a test that fails on the code before the change (FeltKit main
`8826fdf`; AppBoundry before its tenancy commit) and passes after it.

| ID | Platform fix | Where | Reproduction / evidence | Ledger now |
|---|---|---|---|---|
| G-05 / FK-GAP-013 (tenancy) | `tenancy@1`: the artifact's guest runs FeltKit's own tenancy over the host's copy of its records; the host keeps each session's organization and resolves the live membership on every request; `/api/tenants/*` with FeltKit's paths; operator provisioning | FeltKit `appboundry/guest-tenancy.ts`, reference host; AppBoundry `src/tenancy.ts`, `http.ts`, `admin-channel.ts` | FeltKit `test/tenancy-parity.test.ts` (8 scenarios × Node and artifact); AppBoundry `test/tenancy.test.ts` (7, production, HTTP; all fail before) | Runs on AppBoundry with organizations (`tests-artifact/`, `scripts/appboundry-acceptance.mts`). Accounts are **not** served (accounts@1 is still a proposal): an operator issues sessions. |
| G-01 | A job records the workspace it was queued in (same transaction as the job); it runs there as its initiator through the live membership, and is refused once the membership or the permission is gone. Recovered after-commit effects too. | FeltKit `runtime/job-context.ts`, `services.ts`, `runtime.ts`; AppBoundry `services.ts`, `host.ts` | FeltKit `test/tenant-platform.test.ts` (4 G-01 tests, fail on main); AppBoundry `test/tenancy-work.test.ts` (fail on the tenancy-only host) | Review scan runs as a background job after each import (`m4` "background job" test; also on AppBoundry's host). |
| G-04 | Files belong to the workspace they were uploaded in (`metadata["feltkit.tenant"]`, set by the platform, never by the caller); another workspace's file is NOT_FOUND for get/read/list/link/remove; upload links re-check membership. | FeltKit `runtime/services.ts`, reference host; AppBoundry `services.ts` | FeltKit 3 G-04 tests (Node and artifact); AppBoundry "files in an organization" | `ledgerTenant` metadata and its check removed. The uploader check stays (Ledger's rule). |
| G-02 | Agent tasks record their workspace (FeltDB `AgentTaskScope.workspace`); every task entry point answers NOT_FOUND across workspaces; approved actions run in the task's workspace (dispatch had dropped the tenant). | FeltKit `runtime/agent.ts` | FeltKit G-02 test (fails on main) | Unchanged: Ledger's proposals are domain records with accounting evidence; not a workaround. |
| G-03 | The artifact build accepts `approval: "required"`, writes it to the manifest, and both the guest and AppBoundry's host refuse non-person callers. | FeltKit `appboundry/build.ts`; AppBoundry `host.ts`, `manifest.ts` | FeltKit `approval-required.test.ts` (Node vs artifact); AppBoundry approval test (host's own refusal) | `requirePerson()` kept (it also guards the posting engine). Re-adding the flag is optional (MIGRATION.md). |
| G-06 | **Investigated, not built.** FeltDB 0.21's state contract (v1) has no write-once or append-only constraint and refuses constraints outside its subset; `immutable` exists only on module field declarations, not enforced on application collections. The paths that could change a posted record outside Ledger's code: Studio data edits (refused in production), `ctx.unsafe.feltdb` (Ledger never uses it; refused in artifacts), and direct database access by an operator. | — | Source inspection: `@feltdb/core/dist/application-state-contract.d.ts`, `module.d.ts`; FeltKit `server/admin.ts` | Unchanged: no posting path patches a posted record; `integrity:check` detects drift. Owner: FeltDB, a write-once collection policy, if a second product needs it. |
| — | Ledger's backend used Node's `Buffer` and Web Crypto, which an artifact's guest does not have (found by running Ledger in the artifact). | FeltKit exports its runtime-neutral `sha256Hex`; Ledger `feltkit/_base64.ts` | `tests/base64.test.ts`; artifact test | Portable on both runtimes. |
| — | FeltKit's reference host Files had no owner or tenant scope, so artifact tests could differ from AppBoundry. | FeltKit `appboundry/host.ts` | FeltKit "G-04 files in the artifact" | — |

Still open, and why:

- **Accounts on AppBoundry** (FK-GAP-013, accounts@1): no sign-up, password, e-mail or invitations on an
  AppBoundry host. Operators issue sessions and provision members. Not in this program's scope.
- **G-07** (notifications per person, not per organization) and **G-08** (unique constraints global unless
  they name the tenant field): not addressed; Ledger's workarounds stay.
- **Schedules**: a recurring schedule's jobs carry no workspace (no initiator request to take one from).
  Ledger uses none.
- **Published releases**: none of the platform changes is published. Ledger vendors a FeltKit build;
  AppBoundry was verified from source.
