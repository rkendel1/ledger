# Vendored FeltKit (pre-release)

`feltdb-feltkit-0.3.25-66e4a11.tgz` is `npm pack` of `packages/sdk` from rkendel1/feltkit branch
`claude/happy-fermat-wynpur` at commit `66e4a11` (FeltKit main `8826fdf` plus the Ledger acceptance
program's platform changes: tenancy@1, jobs in their workspace, Files and agent tasks scoped to the
workspace, approval-required mutations in artifacts, `sha256Hex`).

**The version inside says 0.3.25, but this is not the published 0.3.25.** FeltKit's release process
chooses the next version when it publishes; this copy was not published. Switch back to an npm
version once one containing these changes exists (MIGRATION.md).

`SHA256SUMS` records the tarball; `tests/vendor.test.ts` checks it and that `package.json` installs it.

Rebuild:

```bash
cd <feltkit>/packages/sdk && npm run build && npm pack --pack-destination <ledger>/vendor/feltkit
```
