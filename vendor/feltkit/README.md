# Vendored FeltKit (unpublished build)

`feltdb-feltkit-0.3.26-91c4be4.tgz` is `npm pack` of `packages/sdk` from rkendel1/feltkit branch
`claude/happy-fermat-wynpur` at `91c4be4`: FeltKit main as released in 0.3.26 **plus** the platform
fixes Ledger needs (tenancy@1 for AppBoundry, jobs in their workspace, Files and agent tasks scoped to
the workspace, approval-required in artifacts, `sha256Hex`, "an organization" in the tenant screens). Those fixes are in pull request
rkendel1/feltkit#114, which is not merged.

**The version inside says 0.3.26, but this is not the published 0.3.26.** The published 0.3.26 was
released from main without these fixes, and Ledger does not run on it: the backend does not typecheck
(`sha256Hex`), most tests fail at organization setup, and the AppBoundry build fails.

When a FeltKit release contains #114: set `"@feltdb/feltkit"` to that version, delete this directory
and `tests/vendor.test.ts`, then `npm install && npm test && npm run test:artifact && npm run test:appboundry`.

Rebuild from a newer branch head:

```bash
cd <feltkit> && npm ci && cd packages/sdk && npm run build && npm pack --pack-destination <ledger>/vendor/feltkit
```
