# Reference-aware migration callback

This is a narrow adapter change, not a new release controller or host installer.
It does not select application sources, grant a maintenance window, create an
exclusion receipt, or make a host plan executable. The final source, owner,
runtime and dependency contracts must be reviewed separately for both releases.
Historical deployment guards and the durable controller remain unchanged.

## Ordered explicit migration

`Host.migrate(database)` invokes two fixed entrypoints from the pinned candidate:

1. `scripts/migrate-booking-references.mjs --database DATABASE`, requiring exactly
   `{ "ok": true, "migration": "permanent-booking-vendor-labels-v1", "historicalBackfill": false }`.
2. Only after that confirmed result, `scripts/migrate-notification-outbox.mjs
   --database DATABASE`, requiring exactly
   `{ "ok": true, "migration": "notification-outbox-exact-additive-v1" }`.

Both acknowledgments reject duplicate JSON keys, additional fields, and numeric
substitutes for boolean values. Canonical comparison preserves exact value types.

Both scripts open the existing database directly. Neither calls the initializing
application store. Each commits its own existing immediate transaction; the pair
is deliberately **not** claimed to be one atomic transaction. Label maps are
created empty, never backfilling historical bookings or vendors. The established
outbox migration retains its conservative treatment of uncertain legacy sends.

The existing controller first verifies guards, loaded gates and exclusions,
persists both holds, stops writers and proves quiescence. It creates, verifies
and fsyncs a fresh local SQLite snapshot before recording `MIGRATING` and calling
this adapter. The previously required encrypted off-host backup remains a
separate prerequisite. No backup is restored over the current database.

## Failure and recovery

| Observed database state | Automatic behavior |
| --- | --- |
| Label preflight fails or maps are partial/unreviewed | No outbox call; writers remain held. |
| Labels committed, outbox absent or partial | Journal remains `MIGRATING`; both holds remain. `recover` refuses readiness and does not rerun either migration. |
| Both migrations committed but process died before recording `MIGRATED` | `recover` inspects actual schema, not merely the journal phase; it may select only the pinned reference-aware fallback. |
| Candidate startup/readiness fails after complete migration | Existing controller re-holds/stops, verifies current database, then attempts the pinned fallback. |
| Fallback, guards, pins, quiescence or readiness remain uncertain | No success is reported; holds remain or are restored. |

## Explicit held completion

The separate manual `complete-labels-only` mode is available through the existing
host adapter, source-verified stdin transport, and manual deployment workflow.
It is never selected by `inspect`, `execute`, `recover`, or any default. Both the
transport and host CLI require `--completion-confirmation
complete-labels-only:FULL_PLAN_SHA256`; the workflow has the equivalent optional
input. The digest must equal the exact current reviewed plan file digest. Missing,
wrong, or stale confirmation fails before any hold or service mutation. This token
is an input guard, **not** evidence of user approval: actual host actions still
require the separately approved maintenance/completion action.

This mode must be present in the **same exact package before initial execute**.
Adding it after interruption changes the package/controller pins and durable plan
identity, so it cannot repair an interruption from an older package. Do not move
the package to a new path, clear the journal, repin an interrupted deployment, or
change immutable plan fields to bypass this binding. Only receipt/evidence renewal
already permitted by the durable plan projection is possible; review the resulting
full plan digest and explicitly confirm that new digest.

After confirmation, the existing shared deployment lock protects restoration of
both durable holds and stops of the same three fixed units, even when a later
receipt or plan validation fails. No start action is issued. The normal exact
source/runtime/dependency/Node/owner/config/backup/gate/exclusion guards are then
required again, with concrete process/cgroup/listener quiescence. The journal must
be exactly the same plan's `MIGRATING` or `MIGRATED`, with no target. The pointer
and marker must still identify the original old release. Ready/selected/other
journals and later running-release states are not accepted.

For `MIGRATING`, readonly checks require exact core, owner/staff, label-map and
legacy-outbox schema, empty booking/vendor maps and no consumed map sequence.
All pre-existing schema, table rows (including rowid), non-label sequences and
SQLite application/user metadata must match the private controller-owned snapshot
created before initial migration. The snapshot is only read: it is never exported,
changed, or restored. Its regular single-link identity, size/timestamps and bytes
must remain stable during inspection; access time is deliberately not part of
identity. This narrow initial-transition mode does not accept legitimate later
bookings, changed owner/MFA records, or other intervening data changes.

Only that exact labels-only state may run the same strict label-first/outbox
callback. The label step is idempotent. Full readonly fallback schema acceptance,
unchanged guards, old pointer/marker, both holds and quiescence are required before
recording `MIGRATED`. Success is explicitly
`migration-completed-held-use-recover`: no runtime selection, application startup,
maintenance resume, database restore, or journal deletion occurs.

If either accepted journal phase already has the exact complete additive schema,
this mode verifies it and returns `already-complete-held-use-recover`, without
calling either migration or writing the database/journal. This covers a crash
after outbox commit and a lost successful response. A `MIGRATED` journal with an
incomplete schema is refused, never reinterpreted as legacy. If interrupted while
still labels-only, a separately approved retry of this same confirmed action is
idempotent; partial/drifted schema remains held. Successful completion never
automatically invokes recovery. The separate existing `recover` verifies current
data and may select only the pinned reference-aware fallback, without restoring
the snapshot. It retains current post-migration bookings and owner/MFA state.

## Local regression coverage

Supply local, already reviewed candidate and fallback source directories with
working test dependencies, plus the compatible Node executable. These are test
inputs, not materialized host plan identities:

    export PYTHONDONTWRITEBYTECODE=1
    export BW_TEST_CANDIDATE=/absolute/local/candidate
    export BW_TEST_FALLBACK=/absolute/local/fallback
    export BW_TEST_NODE=/absolute/local/node
    python3 -B -m unittest discover -s tests -p 'test_*.py' -v

The new tests use real migration CLIs, disposable SQLite databases, and the
unchanged controller's execute/journal/recover path. Service, loaded-gate,
quiescence, readiness and approval boundaries are simulated, never represented
as proof of a real host. Abrupt child-process termination after each commit tests
the actual durable failure boundary. Completion tests exercise the production route, real CLI parser/plan digest,
exact workflow confirmation shell, actual backup-expiry guard, shared lock,
snapshot/data comparison, and abrupt interruption retries. They prove no
automatic selection/start, no unconfirmed mutation, and separate fallback
recovery without snapshot restoration. Owner capabilities, MFA,
historical records, payment references, old idempotency rows and permanent
mapping/high-water data are retained. No provider or external service is called.

## Test-input portability

The callback/completion unit and fault tests can run with the same current
checkout supplied explicitly as both `BW_TEST_CANDIDATE` and `BW_TEST_FALLBACK`:
the tested migration/readiness interfaces are shared, while controller release
roots and manifests remain independent disposable fixtures. This is appropriate
for ordinary source CI and needs no unpublished sibling directory. A compatible
Node executable and installed test dependencies are still required. Missing
inputs fail, never silently skip. The partial control overlay itself is not an
application checkout, so its standalone acceptance uses explicit external source
inputs as shown above.

Final release acceptance must additionally supply the **two distinct exact
reviewed candidate and fallback source trees**. A same-checkout CI pass is not a
claim of cross-version compatibility or final source-profile acceptance. This
control overlay deliberately leaves application source profiles and publishing
commit identities unchanged for the separate final reconciliation.
