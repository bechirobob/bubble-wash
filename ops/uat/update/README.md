# Isolated UAT update controls: prepared, not deployed

This package implements one guarded update of the existing isolated UAT service.
The reviewed `.github/workflows/uat-update.yml` supports explicit approved dispatch only.
`uat-update.workflow.template.yml` remains hard-disabled as the review baseline.
No host operation occurs on push or pull request.

## Scope
- Existing original runtime f4fd4ce; exact reviewed main candidate/control SHA.
- Existing UAT unit, environment, session secret, database and expiry retained.
- Production paths/routing/services unchanged; no credential/account creation.
- Staging is fixed under /opt/bubblewash-uat/update. Existing directory blocks
  repeats, including a failed upload. Persistent operation marker blocks retries.
- Trusted source/artifact, Node22 and loaded unit/isolation checks before stopping.
- Protected SQLite snapshot includes committed WAL data. Source DB/WAL bytes
  remain unchanged; SQLite SHM reader marks may change.
- Atomic app/candidate exchange retains previous code. No automatic rollback,
  database restore or retry. Uncertain outcome requires read-only inspection.
- Existing expired GPS cleanup may occur at application startup. All account,
  schema and other business/ledger table values are checked unchanged.

## Verification
62 local tests pass: transaction fault injection, SQLite/WAL snapshots, archive
safety and permissions, atomic directory exchange, process/job checks, receiver
integration, deadline propagation, bounded transport/receipts and repeat refusal.
All process/network tests use mocks. File tests use temporary synthetic fixtures.
Original-to-current synthetic application rehearsal separately verified four-role
sessions, schema and rows, unchanged privileges and original expiry enforcement.

Run: `python3 -B -m unittest discover -s ops/uat/update -p 'test_*.py' -v`.
Pilot CI also discovers these through the restoration test wrapper.

## Before a live update
Review and publish the exact source, pass full release CI, independently approve
and install the workflow, build exact UAT artifact off-host, obtain the specific
UAT interruption approval and reserve a quiet window with all operators. Flags
attest approval already obtained; they do not grant it. The expected expiry must
match current host accounts; no extension is provided.

A switch temporarily stops only UAT. A failed/uncertain check may leave it
unavailable until inspection and a separately verified recovery. No guaranteed
downtime duration is claimed. A pre-stop guard requires 15 minutes before account
expiry and at least 180 seconds on the original remote execution deadline.
The code assumes exclusive coordination against other privileged host operators.
It does not claim to defend against a concurrently malicious root operator.

Do not invoke the adapter manually, remove retained update folders/markers to
retry, repin historical restoration controls or use the production deployment
workflow as a substitute.
