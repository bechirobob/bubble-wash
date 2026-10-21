# Fresh-start release: prepared procedure, not execution approval

This is a maintenance-window plan for the separately confirmed Bubble Wash reset.
It is not a runnable deployment replacement. Host inspection must fill the ingress,
service and existing backup-access gaps below before any live action. Keep the
unconditional guard in `production-deploy.yml`. Do not run `deploy-production.sh`:
it creates a pre-reset backup, rewrites security settings and disables staff auth.
Neither the plan nor the fresh-start backup input grants live release authority.

## Read-only go/no-go, before the maintenance window

- Verify the reviewed source SHA, clean release contents, CI and exact service
  working directories. The baseline reviewed here is PR45 at
  `eb086efca4088518f99cff404265f8fb66b6297b`; this patch still needs publication,
  review and CI, and its eventual SHA must replace that baseline for execution.
- Inspect the existing ingress maintenance capability and prove that it blocks
  public reads/writes, payment webhooks, old app processes and background jobs,
  without disabling owner authentication. Identify a private operator path for
  sign-in verification. Do not invent a proxy rule or change security permissions.
- Verify existing owner password sign-in and enabled MFA; retain credentials,
  session/MFA keys, recovery codes and effective admin records unchanged. Record
  only pass/fail and secret-free digests, never credentials or customer contents.
- Inspect existing backup token, private repository ID/SHA pins and key presence
  using their normal authorized context. Run the existing `check_store.py`
  destination validation, without uploading anything. Missing/invalid access,
  changed scope or absent encryption key stops execution; do not generate a token.
- Confirm absolute database path, existing env-file syntax, actual unit definitions,
  legacy-worker credentials absent, and no pending submissions.jsonl. Missing
  infrastructure settings, operator/legal fields or auth prerequisites are blockers,
  not settings this plan fills in. Preserve existing archives/rollback releases.
- Identify and temporarily freeze all backup/deploy schedules and direct writers
  for the approved window. Nightly backup currently does not hold the deployment
  lock across transport. A lock alone is not evidence those writers are frozen.
- Obtain grouped approval for the exact resulting release/account-model change,
  host-specific maintenance/freeze method, reset scope, existing private backup
  destination and final reopening. No permanent deletion beyond the confirmed
  database scope, new persistent credentials, auth changes or external messages.

## Controlled sequence under one continuously held deployment lock

1. Acquire `/home/ubuntu/bubblewash-runtime/deploy.lock` with `flock -n` in a
   persistent operator session. Keep the owning file descriptor open through final
   verification. If the session is lost, stop and reinspect lock/services/state;
   do not automatically resume, restart writers or rerun reset.
2. Build the reviewed candidate separately, with no backup call and no production
   configuration writes. Verify build output, SHA and required routes. Apply the
   approved ingress maintenance boundary and schedule/direct-writer freeze.
3. Stop maintenance timer/service and application. Confirm every writer is stopped.
   Switch the existing current-release pointer to the matching reviewed candidate
   using the inspected layout, preserving the old code release for rollback.
   Do not install/rewrite units, alter env settings, or invoke the old deploy script.
4. Start only the candidate privately for pre-reset owner sign-in/MFA and account
   model validation, then stop it again. This is internal maintenance activation,
   NOT a healthy/public deployment. `/api/ready` remains unchanged and must still
   report missing/stale backup. Any other readiness error stops this plan. A fresh
   existing backup may already make it green, but it does not replace post-reset
   backup verification. Never turn a readiness error into a success response.
5. From the resolved current directory, run the existing reset inventory with the
   exact production service environment and the user-systemd bus. Confirm the
   listed counts/fingerprint match the approved scope in `FRESH_RESET.md`. With
   all writers stopped, execute its exact fingerprint-bound `--apply` procedure.
   This transaction preserves admin/security rows and fails closed on drift.
   Record its successful counts, not personal records. Do not reseed test data.
6. Keep ALL writers stopped. Dispatch the reviewed nightly workflow from main with
   `fresh_start=true` only now, using existing approved private backup access.
   Verify that both workflow source and the VPS current working directory contain
   this reviewed patch; workflow checkout alone does not update host scripts.
   The guarded mode verifies actual stopped units, empty operational/nonadmin
   records and usable preserved admin config. It makes an encrypted restore-tested
   backup of a compacted TEMPORARY snapshot, excluding deleted free-page contents.
   It does not compact the production DB or prune existing archives. Status remains
   pending until the private transport publishes/download-verifies the exact file,
   saves its durable receipt, then finalizes status against that receipt. No key
   is exported. Missing receipt, transport failure or remaining data stops the flow.
7. Fresh-start workflow intentionally does not call public readiness while the app
   is stopped and ingress closed. This is not a readiness waiver: wait for verified
   transport completion, inspect the exact file/hash/receipt and then start only
   the application under the same unchanged environment, maintenance still stopped.
   Require unchanged normal `/api/ready` success, health and public route smoke tests
   through the private operator route, same owner sign-in/enabled MFA, no reseeding,
   empty operational lists/rosters, and invalid old worker credentials/sessions.
   Read-only checks only: no real orders, payments or outgoing messages.
8. Only after ALL checks pass, restore the approved ingress state, restart the
   preexisting maintenance timer, restore intended schedules, verify public HTTPS
   readiness and actual timer state, then release the lock. Record exact deployed
   SHA, reset counts, backup receipt identity and tests. Do not claim success based
   only on an HTTP health endpoint or a workflow completion flag.

## Failure and rollback rules

Before reset: restoring old code is allowed only within the approved procedure,
with writers/ingress still frozen and owner access verified. No old-data backup.
After reset commit: never restore old operational data or automatically switch to
old code that may reimport/reseed/revive workers. Keep maintenance/ingress restricted,
report the failed gate, and repair forward only within authorization. Backup failure
means no public reopening. Do not rerun reset on a changed inventory. An unverified
outcome requires inspection before retry. Historical archives remain untouched.

## What this patch does and does not establish

Adds guarded compacted fresh-start backups, receipt-bound finalization, and an
explicit workflow input using existing transport. Normal production readiness and
the blocked old deployment workflow are unchanged. Synthetic tests establish local
behavior, not live owner access, ingress control, token availability or production
success. A host-specific activation implementation and its review remain required;
this document deliberately does not turn unverified service assumptions into a
one-click production reset.

## Optional read-only preflight publication/run request

`.github/workflows/release-preflight.yml` is prepared but not published or run. It
uses the exact existing review branch and only triggers on changes to itself or
`scripts/release-preflight.py`; manual dispatch remains subject to GitHub workflow
registration. Publication of either path can therefore trigger host inspection and
must be approved together with that run, not treated as draft-only publication.

It retains the existing `backup-storage` environment. If that environment permits
only main, the review-branch job is blocked. Do not broaden its branch permissions
or move its secrets. The private destination precheck verifies existing identity
and commit pins with read-only API calls; it cannot prove upload permission.

The SSH route and pinned Tailscale action are reused without new keys, tokens or
host-verification bypasses. Python is streamed to stdin with bytecode writes off.
The script never sources the environment file, imports app code or prints its
values. Reports contain fixed flags and aggregate counts only. Unknown schema
names, customer/admin identities, paths, process IDs, host identifiers and raw
errors are not emitted. Shell/SSH error details are suppressed rather than
published. Existing workflow source already contains the established SSH alias.

SQLite is never connected to the live database. WAL/journal-mode databases are
skipped; bounded stable rollback-mode bytes may be inspected in host memory only,
without a stored backup or source sidecars. Such counts are diagnostic, NOT the
locked fingerprint-bound reset inventory. Unsupported syntax/schema/runtime or
inputs above the bound produce an explicit skip, not a guessed success.

The readiness endpoint is deliberately NOT called: existing application readiness
can initialize schema/import legacy data and purge expired location rows. Live
readiness, interactive owner/MFA access, effective runtime environment, ingress
maintenance, all direct writers and private-destination write access remain
unproven. Possible process counts are hints, never a writer-free guarantee.
