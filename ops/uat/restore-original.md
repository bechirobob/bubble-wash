# Original UAT cohort restoration (prepared, not executed)

This operator is intentionally outside the application. It restores only the four
original role accounts identified by the original `approved-uat-issuance` audit
records at 2026-10-26T23:19:33.802Z. The historical expiry is
2026-11-02T23:19:33.802Z. It refuses revoked targets, any prior restoration,
nonexpired targets, duplicate/missing roles, missing roster bindings and stale
inspection fingerprints. It updates credentials and the 168-hour window in one
immediate transaction and records both historical and replacement timestamps.
Original creation timestamps, bindings, records, audit history and every other
account are preserved. Each restored account gets a new credential version.

The exact passwords must come privately from page 2 of the authoritative version-5
UAT PDF. The operator cannot establish that supplied passwords match that PDF once
expired hashes have been cleared: this remains an execution prerequisite. Do not
use generated replacements, command arguments, workflow inputs, logs, source files,
or public artifacts to transport credentials.

## Required execution gates

1. Coordinate exclusive host access with the task coordinator. Use the existing
   protected environment and shared `bubblewash-production` concurrency lock.
   Do not deploy the current application or touch the production owner operation.
2. Verify the actual UAT runtime revision, service UID, loopback port 3108, effective
   unit isolation, provider-disable flags, root-owned app and separate UAT database.
   Historical revisions are evidence to compare, not permission to assume a match.
3. Review this exact operator and tests, and run them with the deployed runtime's
   pinned dependencies. Stage only reviewed operator code through an approved
   transport. No runtime rebuild, migration, getDatabase initializer or service
   restart is needed. This change does not itself provide that host transport.
4. Run the operator as the isolated UAT user with its verified environment, under
   Node's react-server condition and TypeScript stripping. An `inspect` request
   on private stdin opens the existing database read-only and returns an eligible
   count and compare-and-swap fingerprint. Retain the receipt privately.
5. Read the authoritative version-5 PDF page 2 through Library read; complete
   page text has been verified and permits private extraction without local PDF
   bytes. If bytes become necessary, use only supported Library materialization.
   Compare the four role credentials with the exact original targets privately.
   Do not store them in GitHub without separate action-time destination approval.
6. Submit `restore` with `fingerprint` and exactly four `{username,password}` entries
   through a reviewed confidential stdin route. Never reissue the cohort or renew
   subordinate accounts. Receipt output contains only count, window and status.
7. If execution fails or transport is interrupted, inspect current state before
   retrying. A committed restoration deliberately fails subsequent eligibility.
8. Verify all four exact PDF logins privately against the isolated public service,
   role routing and new expiry. Verify revoked child access remains denied, old
   sessions remain denied, and records/rosters/unrelated accounts are unchanged.
   Do not exercise mutating reviewer workflows. Return only a sanitized receipt.

Test: `node --conditions=react-server --experimental-strip-types tests/uat-restore-original.integration.mjs`

Until these execution gates pass, this is a draft implementation, not restored
access. No restoration workflow, production deployment or routing change is added.

Local collector/transport/receipt additions are described in `restoration-workflow-design.md`. Exact-source CI, protected workflow release, and authorized live verification remain separate execution gates.
