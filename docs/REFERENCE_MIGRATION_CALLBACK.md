# Full integration migration callback

This is a bounded update to the existing adapter, not a new controller or host
installer. The historical provenance baseline remains
`5dc997db0393e1cf88dde29859b7e1c4550ee4ee`. The v2 host plan explicitly binds the
current execution baseline `853b7c1020fb7dab66f302a2603369d5fa8b3dff`, tree
`24fbe62668c996d0821153cf341b24765ef653b1`. Neither baseline is substituted for
the other. All vendored durable, transition, and preserving primitives remain
byte-identical. Exact source selectors remain fail-closed.

This local proposal grants no production maintenance or security permission.
Installed gates, staging custody, explicit coordinated-operator risk acceptance, known-app unit evidence, fresh
backup, owner evidence, built runtimes, dependencies and final source commits
must be independently established and approved. V2 candidate/fallback directories
use the exact full40 commit names under the existing protected releases root,
matching the inactive stager; arbitrary64 package names are not runtime names.
The separate `prepare` mode now supports inactive builds and two rehearsals from
one private current-data copy. It is not a production upgrade, gate installer or
migration approval. Synthetic-fixture timings are not a migration-window estimate;
only the separately approved actual preparation run can supply host timings.

## Separate control and runtime custody

Application runtime artifacts remain frozen independently from this control
checkout. The two runtime profiles bind exact published commit, complete Git
tree and source-content commitment. A control commit is never substituted for
an application commit, nor accepted as an enrollment or deployment profile.
The manual workflow checks out controls at `GITHUB_SHA` and the runtime at the
separately supplied, code-pinned `candidate_sha`; both identities are checked
before transport. The candidate still requires the unchanged exact-main CI
checker. A control run does not manufacture missing runtime CI evidence.

The reviewed capsule's two unchanged files live under
`ops/integration-release/capsule/{scripts,tests}`. The app-UID invocation uses
its protected absolute control path and `--source` points at the independently
verified runtime, which supplies only its DDL and dependencies. Both capsule
files are covered by `adapterFiles` and durable `controllerPins`; no capsule or
test is added to an immutable runtime artifact, and package scripts are unchanged.
The existing Python migration suite runs all 40 capsule tests from this control
path, in addition to the real-CLI crash and preservation tests.

`controlRunner` is a single separately named exact content commitment for CI
checkout recognition. It is not a third runtime profile. Only the explicit
runner-only selector and existing runner-only enrollment check may consume it;
runtime selectors and historical host/enrollment contracts reject it. The owner
document workflow uses runner-only recognition solely for its control checkout
before the separate live-runtime checkout; its exact live runtime pins, recipients
and issuance behavior are unchanged. A future full deployment does not refresh
those historical owner runtime pins: they continue to fail closed until separately
reviewed. Existing
source traversal remains strict and the control subtree is still independently
pinned rather than weakening source checks or copying an inventory.

Fallback acceptance requires exact bound runtime CI and the independently
reviewed control-proof receipt. The earlier failed backup run remains failed
historical provenance. Unset receipt pins fail closed before network or host
access; public artifact metadata alone is not a review of its assertions.

## Pre-maintenance preparation

`prepare` takes no deployment plan, completion token, configuration or credential
input. Its exact public request contains runId, first runAttempt, the two pinned
published runtime SHAs, verified backup/receipt/store identities and Node path/hash.
The workflow verifies the clean control Git checkout, both independently checked-out
runtime commit/tree/content bindings and the required hosted CI proofs before
transport. Missing new-run or reviewed proof-receipt pins keep it held.

Four fresh app-owned workspaces receive exact Git archives: independent build and
production-install roots for each runtime. The bootstrap creates/validates only
approved fixed staging roots, then stages one fresh public control package through
the unchanged stager. It verifies every package file before importing the adapter;
the capsule remains separate from both runtime artifacts. Existing fixed roots
must already have exact safe modes and root:root ownership. The bootstrap requires
root effective uid/gid and process-local umask022, without correcting existing
permissions or changing persistent settings.

This inactive workspace/package staging occurs BEFORE the helper's retained
production deployment lock and live853 binding. It does not stop services, create
holds, open the live database, select code or alter configuration. All builds,
private DB copying, copy-only migration/probes and final binding checks then run
UNDER the retained lock. No durable deployment state/controller is constructed.

The helper verifies live code, process/config flags, complete environment bytes,
backup evidence and database identity. Writers may continue, so live row equality
is deliberately not required. One bounded read-only SQLite backup is retained in
`rehearsal-evidence/<run>-1/preimage.sqlite` with private root custody. Candidate and
fallback probes each derive from a separate disposable copy of this SAME preimage.
Both must pass exact migration/preservation proofs and read-only runtime probes;
the preimage itself must remain unchanged. It is never reused as the later actual
maintenance snapshot or journal, exported, or restored over the live DB.

Builds use fresh app-owned roots and a private temporary npm cache. Production
packaging omits only the exact untracked lock-declared generated tooling subtree,
retains tracked source, and canonicalizes only the two reviewed newly installed
dependency file modes before final manifests. Frozen runtime/source/dependency
proofs remain strict. No `.next/cache` or writable-code exception is admitted.
Public output is bounded status/stage/timings, packageId, private evidence-file SHA and no-maintenance-approval flags;
full manifests, preservation evidence and the preimage stay private. Record the
actual snapshot/build/migration-proof/probe durations before proposing a window.
Any uncertain or failed attempt is retained and requires inspection, never an
implicit retry, overwrite, cleanup, service switch or production migration.

## Protected host plan handoff

The implemented `materialize` mode consumes the exact prepared package, successful
private evidence hash, externally reviewed public owner/operator record objects
and hashes, actual residual-risk approval reference, and current backup pins.
The runner supplies real clean runtime commit/tree bindings. Under the retained
lock it reconstructs source trees, verifies the private runtime/dependency proof
and current host bindings, stores only validated private review records, and
exclusively writes one0600 plan. It emits the plan SHA, never private contents.
It does not stop services, create holds, open live SQLite or execute a controller.
Actual risk approval and separate approval of this exact final plan remain required.
See ops/integration-release/HOST-EVIDENCE.md for exact fields, the explicit
coordinated writer assumption, nullable inactive cgroups and initial-only renewal
limitation. No global invoker-exclusion boolean is fabricated.

## Initial execution

The explicit CoordinatedController (unchanged inherited orchestration) verifies the existing guards, writes durable application
and maintenance holds, stops application/maintenance/timer writers, proves
quiescence, and creates and fsyncs a consistent private SQLite snapshot. The
separately verified encrypted off-host backup remains required.

The adapter then performs these exact steps against the explicit existing DB:

1. `CONTROL/capsule/scripts/migrate-integration-features.mjs --preflight --database DATABASE
   --source CANDIDATE` opens readonly/query-only and positively verifies exact
   legacy outbox, absent label maps, required core/staff/owner/research schemas,
   and exact admitted optional schemas. Unknown or partial schemas refuse before
   either legacy migration. The reviewed initial model has no AUTOINCREMENT
   table and refuses even a residual empty `sqlite_sequence`; pre-migration
   rehearsal must report this exact limitation before the first legacy CLI.
   Any unexpected real-host sequence requires new schema evidence/review, not
   an expanded allowance. A private snapshot comparison proves the unchanged
   initial preimage.
2. `scripts/migrate-booking-references.mjs --database DATABASE` creates empty
   booking/vendor maps. No historical booking or vendor backfill occurs.
3. `scripts/migrate-notification-outbox.mjs --database DATABASE` applies the exact
   eight-column/index extension and deterministic conservative legacy conversion.
4. `CONTROL/capsule/scripts/migrate-integration-features.mjs --database DATABASE --source CANDIDATE`
   applies one immediate transaction for five reachable feature tables and only
   the exact historical ownership-table `order_id TEXT NOT NULL DEFAULT ''`
   addition. The exact historical two-column `driver_location_stops` also gains
   `generation TEXT NOT NULL DEFAULT ''` and `order_id TEXT NOT NULL DEFAULT ''`
   in that same transaction. Existing stop values and rowids remain unchanged;
   inactive empty defaults do not resume GPS sharing. No partial/foreign location
   shape is accepted. It never creates the optional customer-receipt table.
5. Positive complete-schema checks and exact preimage projection checks must
   pass before the frozen controller may expose the candidate.

These three migration commits are deliberately not described as one atomic
transaction. Acknowledgments reject duplicate keys, extra fields, wrong types,
uncertain output, invalid feature counts, non-boolean `locationColumnsAdded` or
`ownershipColumnAdded`, and unrequested optional-table creation.
No migration invokes application initialization, cleanup, historical import,
account reset, notification sending, or configuration changes.

All existing account/invite/MFA values, research records/outbox, expired-location
and rate-limit rows, and other pre-existing rows/rowids/schema/metadata are
preserved. The full environment remains digest-bound; research OPEN and EMAIL
remain true, booking remains paused, staff authentication remains enabled and
demo login remains disabled. Commercial automation must remain disabled under
the app's exact boolean rule:
`NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED != 'true'`. This neither enables
WhatsApp automation nor invents an approved template; unrelated research/email
flows are unchanged. The earlier retained host evidence did not report this
boolean, so its live value is not yet verified. Keys are neither read into subprocess environments
nor written. Readonly SQLite can still coordinate WAL shared memory; no
`immutable` shortcut or stale-read claim is made.

## Held recovery states

The pinned feature model positively classifies:

- `initial`: exact pre-migration schema, absent maps and legacy outbox.
- `labels-only`: exact maps and exact legacy outbox.
- `features-pending`: exact maps/additive outbox, but feature schema not complete,
  including an exact old location-stop form even when all five tables exist.
- `complete`: all five feature tables and supported current ownership schema.
- Anything unknown, partial, malformed or unreviewed: refusal, with holds retained.

`recover` never reruns migrations. An incomplete state remains held. A complete
state may select only the independently reviewed migration-aware fallback,
never old853, and never restores the snapshot or any stale database.

Before any target could have served requests, both completion and recovery
require exact original schema/rows/rowids/metadata with only the declared changes:
new maps/sequences are empty; outbox status/error/conversion and every added-column
default are exact; new feature tables are empty; existing ownership rows gain only
an empty `order_id`; exact old location-stop rows gain only empty `generation`
and `order_id`. Existing feature rows are preserved, not required to be empty.
The snapshot is private, identity/stability checked, read only, and never exported.

After a durable selected/ready phase could have exposed a target, legitimate
account, research, booking or feature writes may advance. Recovery validates the
exact journal/plan and current complete schema, not stale whole-database equality.
It keeps current data and leaves maintenance held even after fallback readiness.

## Separately approved completion

The explicit mode is now `complete-migration` in both host CLI and existing
stdin/workflow routes. The prior `complete-labels-only` token is not accepted.
`inspect` remains the default. Completion requires the exact input token
`complete-migration:FULL_PLAN_SHA256`; missing, malformed or stale tokens fail
before any host action. This token is an input guard, not proof of user approval.
Separate explicit approval of the actual bounded completion action is required.

The exact same package must have been bound before initial execute. Never change
its immutable pins/path, clear the journal, or substitute a new controller to
repair an older interrupted transition. Only already-permitted receipt renewal
may preserve journal identity, with review of the new full plan digest.

Under the existing deployment lock, completion restores both holds and stops the
same three fixed units, even if later validation refuses. Exact source/runtime,
dependency, Node, owner, config, backup, installed-gate and coordinated-operator acceptance
checks apply. The journal must be canonical, match the same plan, have phase
`MIGRATING` or `MIGRATED`, and have no target. The pointer/marker must still identify
old853 and all writers must be quiescent.

For a positively classified and preimage-verified `MIGRATING` state, completion
runs only the remaining steps: initial runs labels/outbox/features, labels-only
runs outbox/features, features-pending runs features only. It does not replay
completed steps. Complete schema plus preimage preservation is required afterward.
Success records `MIGRATED` and returns `migration-completed-held-use-recover`.
There is no runtime start, pointer change, maintenance resume, journal deletion,
or automatic recovery. A separate recovery operation remains necessary.

An already complete held state returns `already-complete-held-use-recover`
without a migration or database/journal write. `MIGRATED` with incomplete schema,
unknown journal states, consumed new maps/features or any undeclared old-row
change refuse. Any further attempt after interruption requires fresh separate
approval; uncertainty is never converted into an implicit retry.
