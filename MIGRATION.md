# Migration: Ledger on the remediated platform

What changed when the platform gaps Ledger found (GAP-REGISTER.md) were fixed in FeltKit and AppBoundry,
what Ledger changed in response, and what an operator of an existing Ledger installation must do.

## Platform versions

| Component | Before | Now |
|---|---|---|
| FeltKit | `@feltdb/feltkit` 0.3.25 (npm) | Vendored build of rkendel1/feltkit `claude/happy-fermat-wynpur` @ `66e4a11` (`vendor/feltkit`, checked by `tests/vendor.test.ts`). Reports version 0.3.25, but is **not** the published 0.3.25. |
| AppBoundry host | Refused `ledger.app` (identity.tenancy), or ran it with organizations closed | rkendel1/appboundry `claude/happy-fermat-wynpur` @ `b706321`, from source (not published) |

When FeltKit publishes these changes: set `@feltdb/feltkit` to that version in `package.json`, delete
`vendor/feltkit` and its test in `tests/vendor.test.ts`, run `npm install`, `npm test`, `npm run test:artifact`.

## What Ledger changed

| Change | Why it is now correct | Removed workaround |
|---|---|---|
| The review scan runs as a background job after each import (`review.scan` → `review:scanJob`); the UI no longer calls `review:scan` after an import | Jobs run in the organization they were queued in, as the importer, through the live membership (G-01) | Synchronous scan from the browser |
| Bookkeeping roles hold `jobs.create` and `jobs.execute`; the account-level `person` role still holds nothing | The job's permissions come from the importer's organization role, not from an account-wide grant | — |
| Uploads no longer write `ledgerTenant` metadata; `bind` no longer compares it | Files are scoped to the organization by FeltKit (G-04); the subject lookup is organization-scoped as well | `ledgerTenant` check |
| `patchRemoving()` replaced by `ctx.db.patch(…, { field: undefined })` | FeltKit always removed such fields; the gap entry G-09 was wrong | `patchRemoving()` |
| `feltkit/_base64.ts` and FeltKit's `sha256Hex` instead of `Buffer` and Web Crypto | Required to run inside an AppBoundry artifact | — |

## Kept on purpose

- **`requirePerson()`** in every financial mutation and in the posting engine. FeltKit's
  `approval: "required"` is now enforced in artifacts too (G-03), but it guards a function's caller, not
  the posting engine that several functions share, and Ledger's guard is tested on both runtimes.
  Adding `approval: "required"` to the financial mutations as well is safe now; it would also let
  agents propose them through FeltKit's own lifecycle on a FeltKit server.
- **Ledger's own proposals** (`proposals` collection). They carry accounting evidence and Ledger's
  separation-of-duties rules; FeltKit's agent tasks are now organization-scoped (G-02), but replacing
  Ledger's proposals with them would be a product change, not a workaround removal.
- **Integrity check** for posted records (G-06): FeltDB has no write-once collections; decided not to
  build one without a second product needing it (GAP-REGISTER, Remediation).

## Existing installations

No Ledger installation has been deployed, so no data migration was run. If one exists:

- **Receipts and statements uploaded before this change** carry `ledgerTenant`, not FeltKit's
  `feltkit.tenant`, so FeltKit now hides them from every organization (NOT_FOUND). Each such file needs
  `metadata["feltkit.tenant"]` set to its organization (the value of its `ledgerTenant`) by an operator
  with direct access to the Files records. FeltKit offers no application API for that today; this
  would need to be written and tested before upgrading a live installation.
- **Jobs queued before the upgrade** have no organization record and run as before (no organization).
  Ledger queued none on 0.3.25.

## On AppBoundry

```bash
npx feltkit build --target appboundry                  # ledger.app (requires tenancy@1)
appboundry run ledger.app --accounts operator-sessions # Ledger declares built-in accounts, which the host does not serve
appboundry admin users add ada --role person
appboundry admin sessions issue --user ada
appboundry admin tenants provision --name "Acme LLC" --user ada --role owner
```

People then work in their organization over the same `/api/tenants/*` routes the FeltKit server serves.
There is no sign-up, password, e-mail or invitation on AppBoundry (accounts@1 does not exist).
