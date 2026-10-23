# Exact survey-only release and final activation

Preparation only. This source package does not authorize publication, host execution,
configuration change, a provider request, or opening real collection. Each live
operation must stay within the separately approved sequence below.

## Separate source custody

The controls live on current main. The runtime is a different, reviewed commit
based on live `5dc997db0393e1cf88dde29859b7e1c4550ee4ee`, with exactly 34 changed
paths: accepted survey/intro changes, focused tests, the Zod-only lock correction,
and the already-reviewed synthetic operator script. Runtime tree:
`4be4867d49f374a753072f3f495e51bc8055d17a` (297 tracked files).

`ops/survey-only-source-pins.json` binds both complete source maps, core source
manifests, exact research DDL, and unchanged preserving helper. A runtime commit
SHA is supplied only after publication, and must resolve to that exact tree.
Current-main controls are not copied into the application artifact. The old
preserving transition constants and entrypoint are neither modified nor called.
The five new control paths are this document, `ops/deploy-survey-only.py`,
`ops/survey-only-source-pins.json`, `tests/test_survey_only_deploy.py`, and
`.github/workflows/survey-only-deploy.yml`.

## Explicit sequence

1. `mode=verify`: hosted exact-lock unit/data/auth/typecheck/audit/build and existing
   browser assertions, including the open-survey fixture. No production tailnet,
   protected environment, host write, or runtime deployment. Record the successful
   first-attempt run for the exact control SHA and runtime SHA.
2. `mode=deploy`: repeat that same exact runtime verification, use existing
   backup-storage and tailnet, stage as the existing app UID, build without
   production secrets, rehearse both rollback and candidate on separate private
   SQLite copies with the additive schema, then briefly stop/switch/start the
   application. Collection and ordinary survey email must be absent/false in both
   config and effective runtime. No credential is installed here.
3. Separately verify/install the dedicated existing survey key disabled, verify
   runtime/schema and execute the already-reviewed one-time fixed synthetic test
   only through its protected operator route. That route uses its independent
   exact runtime/control pins. The marked test goes ONLY to the protected owner
   recipient, with no info@ recipient, CC or BCC. Real responses still go only to
   info@bubblewash.co. No retries after a prior or uncertain
   provider attempt. This deployment adapter never sends an email.
4. `mode=activate`: require the exact deployed runtime, exact two-table schema,
   durable marked test with state sent, exactly one attempt, recorded provider
   acceptance and the non-personal operator-test-only recipient marker. Old info@
   test receipts cannot satisfy this guard. Require unchanged source/DB binding, and a fresh verified existing backup.
   Explicit `verification_run` must identify a successful first-attempt verify or
   deploy run on the exact same control SHA/runtime SHA. The fixed workflow run-name,
   repository, path, event, branch and terminal status are checked through public
   metadata. No repeated browser suite or host probe is added for activation.
   Only BUBBLEWASH_RESEARCH_OPEN and BUBBLEWASH_RESEARCH_EMAIL_ENABLED change to true,
   followed by one normal application restart and effective flag/health checks.
   Unrelated environment bytes, credentials, staff access, bookings and ordinary
   email settings are preserved. An expired existing collection deadline blocks.

Modes are manual, separate, and never chained automatically. Workflow reruns are
rejected for deploy/activate. Neither an accepted source review nor a passing
hosted verification authorizes a live operation.

## Existing host prerequisites, captured rather than guessed

The existing current-release marker/symlink, app service, root service-control
commands, app UID, existing deployment lock, protected env file, production DB,
rollback build, and verified encrypted backup must already exist. Exact config
bytes/digest and configured canonical DB are captured privately under the lock,
then bound and rechecked. No external config hash or DB-path guess is accepted.
The env guard is the reviewed installer's actual two protected parent directories,
app-owned 0600 single-link file, no xattrs, descriptor-relative no-follow read and
identity checks; it is not the previously overstrict diagnostic ancestor aggregate.
Source and DB checks separately reject symlinks, unsafe ownership/modes or drift.
No permissions, users, services, runtime versions or persistent access are installed.

The encrypted backup receipt must be restore/download verified and at most 30 hours
old, tied to the supplied archive hash/run and existing protected storage SHA/ID.
Archive/receipt freshness and identity are rechecked before transition and after
validation. No backup or DB rows leave the host.

## Preservation proof and rollback

The live schema operation runs as the irreversible app UID/GID with supplementary
groups removed, inside the inherited existing deployment lock. It opens only the
existing DB with `mode=rw`, enables foreign keys, and uses one `BEGIN IMMEDIATE`.
Only the three exact pinned DDL statements are allowed: two research tables and
one declared index (plus SQLite's three declared autoindexes). All prior schema,
rows including hidden rowids, user_version and application_id are fingerprinted
within that transaction and must remain identical. Source/config/DB inode and lock
bindings are rechecked before COMMIT. No application initializer, maintenance
handler, outbox migration, booking reference migration, account, password or MFA
operation is called. Exact already-applied research schema is retained as a no-op,
including all prior research rows. Partial or different research schema refuses.

Before the live transaction, both the exact old owner-aware runtime and the candidate
are rehearsed with this schema on private copies using unchanged preserving.py
isolation and cleanup. Their startup and fixed HTTP routes must leave the copy's
full fingerprint unchanged. Baseline data-store/auth/security/ordinary outbox bytes
are unchanged; baseline maintenance ignores the added research tables. There is
no persistent restart prohibition: the old runtime remains schema-compatible.

Deployment failure restores only the previous code pointer and exact old marker,
then restarts/validates that same owner-aware release. It never restores a stale DB,
drops research tables, or deletes any new responses. Activation failure compares
observed config to the exact old/new bytes before restoring original config with
an app-UID atomic replace and verifying closed effective flags. Unknown source,
config or process outcomes fail closed for manual review rather than overwriting
unrecognized state. No automatic reattempt follows an unknown result. Public output
is coarse status only; no rows, settings, key material, process errors or traceback.

## Local checks

`python3 -B -m unittest discover -s tests -p test_survey_only_deploy.py -v`

The tests cover additive atomic preservation, hidden rowids, no initializer,
existing survey data, partial/mismatched schemas, copy/code rollback, app UID drop
order, child failure/EOF/timeout kill-and-reap, no uncertain repeat, bounded env
custody, exact hosted proof, fixed activation flags and accepted marked-test guards.
All tests use local synthetic files/mocks, not production.
