# Original UAT restoration: local workflow design

Status: **prepared controls, not a completed restoration**. The temporary
GitHub credential destination has separate user approval. That approval does not
change network policy or waive exact-source CI, live isolation checks, confidential
transport, or public verification. The public UAT HTTP 403 remains unresolved.

## Smallest routes

Preferred minimal route if the user already has an authorized host session:
execute a reviewed, pinned preflight/receiver there and supply the four original
PDF pairs over private stdin. Disable terminal echo and shell tracing; use a
reviewed prompt/input reader, not passwords in command arguments or shell history.
No GitHub credential destination is needed. The host receiver is implemented with a pinned protected-workflow caller; a
user's session does not waive source review, isolation or CAS gates.
Do not open a new SSH route to evade a denied public request.

Optional protected-runner route: exactly one workflow, three modes `inspect`,
`restore`, `receipt`. Reuse `backup-storage`, the existing approved tailnet identity,
and `bubblewash-production` concurrency with `cancel-in-progress: false`. It must
run only on exact reviewed main, first attempt, after successful exact-source CI.
No application build/deploy, service restart, routing edit, provider call, new
repository, public artifact, new host access, or production owner action is needed.

The `restore` mode alone may receive a specifically approved environment secret,
provisionally named `BUBBLEWASH_UAT_RESTORE_ONCE`. It contains only an operation ID,
the four exact username/password pairs. The host computes one private CAS
snapshot for this attempt; it is never a public dispatch input. It must not
contain credentials for any other identity. **The coordinator must separately
obtain action-time approval to store these pairs in GitHub before creation. The
existing restore approval is insufficient.** The name is reserved for this operation; approval alone does not imply it has
been configured. Check its current state and never overwrite an unrelated secret. No password, hash, private CAS digest, secret
JSON, or encoded credential payload belongs in dispatch inputs.

GitHub environment secrets are not intrinsically single-use and have no automatic
per-use expiry. Single-use behavior must be enforced by the receiver's atomic
operation receipt and first-attempt guards. The approval must include prompt
removal after the attempt, including failed or cancelled runs. The coordinator
should delete it through an existing authorized administrative route and verify
absence. Do not grant a workflow a new secrets-administration token just to clean
up this secret. If cleanup cannot be reliably arranged, use the user-session
route instead of creating the secret.

## Workflow boundaries

Public inputs are only mode, exact control/runtime revision pins, and a fresh
nonsecret operation UUID. A storage-approval flag is an attestation after actual
approval, not a substitute for it. `inspect` and `receipt` never reference the
credential secret. Avoid putting the secret in job-level environment or exposing
it to setup, dependency-installation, build, or third-party-action steps.

The restore step invokes reviewed Python directly, with the secret in that step's
environment. Python immediately removes it from its environment, bounds and parses
it privately, refuses debug/tracing contexts, and launches the existing approved
SSH command with an explicit child environment containing no credentials. Supply
source and request through stdin pipes, never argv, generated shell text, temporary
files, or workflow output variables. Disable core dumps for runner and host helper.
Capture stdout and stderr concurrently with byte limits and timeouts. Never print
raw stderr, request parse errors, configuration, process environments, or remote
output. Validate a closed, bounded receipt before emitting it. Secret masking is
not the protection mechanism: values must never be printed in the first place.

The receiver must be independently pinned to the exact control commit, accept a
closed mode/input schema and bounded source/request sizes, and use only fixed UAT
paths. Runtime pins come from the approved historical source/artifact evidence,
not from files currently found on the host or arbitrary caller-provided hashes.
No generic command, SQL, path, URL, environment override, or role-edit field exists.

## Strong read-only preflight

`restoration-preflight.py` supplies tested validators; `restoration-collector.py`
collects bounded read-only host evidence. Direct command-line dispatch remains disabled; the protected workflow invokes
reviewed functions after exact-source and action/access gates. The collector reads
its evidence itself; workflow inputs cannot assert observed UID, settings, mounts,
paths, process state, or eligibility. Its required checks are:

1. Read actual `/opt/bubblewash-uat/app/SOURCE_REVISION` and compare to the exact
   approved runtime pin. Verify relevant installed scripts/modules and the unit
   against reviewed source hashes. Verify root-owned, non-writable app/config
   ancestry, no symlinks/hardlinks, and expected regular file types. The newer
   restore operator has a separate reviewed control-source pin; do not pretend it
   shipped in the historical runtime or overwrite unrelated app files.
2. Verify the OS account UID/GID, nonlogin shell and home; active service fragment,
   no drop-ins, PID and process start time; actual process UID/GIDs, capabilities,
   cgroup, executable and cwd; and sole listener ownership on 127.0.0.1:3108. Read
   `systemctl show` and `/proc` without printing their raw output. Repeat PID/start
   checks after collection to reject process replacement during inspection.
3. Compare both the protected environment file and running process environment
   against fixed UAT URL, database, data root, disabled providers and demo login,
   enabled UAT mode and isolated session-secret constraints. Reject unknown
   credential-bearing or injected environment variables, not just familiar
   payment/email names. Return booleans only; never return secret lengths/values.
4. Verify the effective unit's restrictive settings, including no new privileges,
   empty capability sets, strict filesystem protection, fixed writable paths,
   inaccessible production paths, allowed families, IP denial/loopback allowance,
   denied `connect`, socket bind restriction, and process seccomp/no-new-privileges
   evidence. The normalizer must be explicitly tested against the target systemd
   serialization. Unknown values fail closed; never weaken checks to obtain green.
   Effective configuration plus Seccomp=2 is not a new outbound penetration test.
   Do not send any connection probe as part of this read-only preflight.
5. Resolve UAT app/data/database/config paths and independently identify actual
   production/staging paths from their protected configuration and installed
   pointers, without exposing values. Check every path component and leaf type,
   ownership/mode, database device/inode and single-link status, and -wal/-shm
   symlink safety. Compare real-path ancestry, inode identities and underlying
   mount device/root mappings in both host and UAT process mount namespaces.
   A common physical disk is fine; aliasing production files/directories is not.
   Bind mounts can alias data despite different realpaths. Unknown overlay/union
   backing or incomplete production path inventory must block execution.
6. Open only the existing UAT database with SQLite `mode=ro`, `query_only=ON`,
   `trusted_schema=OFF`, and a read transaction. Include committed WAL; do not use
   `immutable=1` against a running database. Do not import normal application
   initialization, account lookup, migrations or expiry housekeeping. Verify four
   original creation-audit entries at the approved historical window, exactly one
   original role each, expiry reached, valid unchanged roster bindings, no revoked
   or disabled target, and no prior restoration. Subordinate accounts stay outside
   the target set. Unknown state or conflicting audit history fails closed.
7. Return only fixed booleans, bounded aggregate counts and reviewed revision pins.
   Hashes of passwords, names, identifiers, configuration, database content and raw
   diagnostics never leave the confidential process. Any CAS digest stays private.

The collector now implements owner/ancestry/inode checks, protected production
configuration/runtime discovery, mount and cache alias checks, strict systemd
normalization, bounded `/proc` reads, process-start/file-identity rechecks, and a
closed public receipt. It returns private PID/start/configuration/database evidence
separately for receiver comparisons across stages. The SQLite operator also binds
the expected device/inode to its actual open `/proc/self/fd` descriptor inside the
write transaction, detecting replacement even if the original pathname is restored.

The normalizer is tested against explicit synthetic serialization fixtures, not the
live host. Unsupported actual serialization refuses; obtaining authorized live
evidence remains an execution prerequisite. Process seccomp/configuration evidence
remains distinct from testing public connectivity or proving filters by a probe.

## CAS and uncertain outcomes

The locally updated operator compares the complete account/audit snapshot in an immediate
transaction, checks every target's old version/status/window, and creates new
credential versions. It refuses any second restoration. The receiver and operation receipt logic require CI at their exact current
source revision; the earlier PR head's result cannot cover subsequent changes.

The implementation binds a single operation UUID to the transaction through
the existing audit `actor` field (`approved-uat-restoration:<UUID>`), preserving all
historical audit rows. Four before and four after entries plus one private
committed-account-state marker commit atomically. The marker never leaves the
database/private receiver. No separate table or application migration is needed.
Any prior restoration blocks another write. Unreviewed triggers/indexes on either
write target and unexpected table schemas are refused inside the transaction.

The receiver must recheck the pinned runtime/service/configuration and inspected
database inode, then compare the confidential account/audit snapshot immediately
before writing. Add a bounded preflight age and include relevant roster state in
its private precondition; merely checking that a roster ID exists is insufficient
if its binding changes after inspection. The exact PDF pairs must match the four
original identity/role bindings privately. Reject stale evidence; never silently
re-inspect and apply against a new snapshot within the same requested attempt.

A separate **read-only** receipt mode accepts only the operation UUID. It queries
existing audit rows without credential input and returns one of these fixed states:

| Evidence | Result | Mutation permitted by this result |
| --- | --- | --- |
| Exactly four matching before and four after entries plus one valid state marker, one original role each, one new 168-hour window, consistent current target state | committed | None; return the same sanitized receipt |
| Matching committed audit, but later account/window/status drift | committed-state-changed | None; preserve later changes |
| No restoration audit for this or another operation and original targets still eligible | not-observed | None automatically; coordinator must reconcile the failed attempt |
| Any other operation restored the cohort | different-operation | None |
| Partial, contradictory, unavailable or unverified evidence | uncertain-stop | None |

Lost stdout, SSH disconnect, timeout, cancellation, or failed receipt validation is
an uncertain outcome, not permission to retry the write. A retry is never inferred
from a workflow's failed status. The receipt must not contain an account identifier,
password, password hash, credential version, snapshot digest or config value.

## Permission and execution gates

- Source/operator approval for the exact complete receiver, collector and workflow,
  followed by relevant local tests and all required exact-head CI checks.
- Separate action-time GitHub credential-storage approval **only if that route is
  selected**, including environment scope, runner exposure and verified removal.
- Coordinator confirmation that the administrative host route is policy-permitted
  and exclusive shared-host work is scheduled against the owner-link task. Existing
  concurrency prevents overlapping participating jobs; it does not authorize a
  new connection or account write.
- Fresh successful complete preflight and private exact credential/target matching.
- Public verification access must be resolved separately, or performed by the user
  through their own already-authorized public access. SSH/local HTTP is never used
  to replace the denied public request. No public-access success can be claimed
  from a host-local check.
- After the authorized transaction, privately check exact role logins, fresh expiry,
  old-session denial and revoked-child denial without mutating reviewer workflows;
  verify preservation and reconcile/remove any approved one-operation secret.

No secret was created, no host operation was dispatched, and no accounts were
changed while preparing this design.

## Local implementation and review evidence

- `restoration-collector.py`: bounded read-only evidence collection; no HTTP.
- `restoration-transport.py`: separate approval gates, source-commit verification,
  private environment consumption, bounded concurrent stdin/stdout/stderr, fixed
  tailnet target, and closed receipt validation. No secret creation API.
- `restoration-receiver.py`: source loaded in memory, fixed absolute module paths,
  unchanged UAT service, transient operation under the reviewed sandbox, core dumps
  disabled and a 120-second host lifetime bound. No credential-bearing argv/files.
- `restoration-runtime-pins.json`: six runtime-source hashes and the unit hash
  verified against historical revision `f4fd4ce424c2b363fc5a2196432e0ac2ce7c05a1`.
- `restoration-workflow.template.yml`: inert proposal outside `.github/workflows`,
  additionally disabled by a constant false job condition.

Independent review identified and prompted fixes for NUL-environment spoofing,
cache/descendant mount aliasing, trigger/index-driven mutations, ambiguous receipts,
mislabelled write receipts, data-URL dependency resolution, and cross-stage database
identity. Re-review found no further execution-code blocker in the local pass.
41 Python tests plus the restoration integration test passed. These are local results, not live host validation or exact-new-head CI.
The active proposed workflow is `.github/workflows/uat-restore-original.yml`;
its public inputs contain no credentials and its credential secret is scoped only
to the restore step after separate approval/access attestations.

The protected operation job does not install dependencies or run project tests.
Those run in unprotected Pilot CI on a separate runner, before the exact-source
CI gate. This prevents an install/test background process from sharing the later
credential-bearing runner.

## Inspection failure diagnostics

Inspection failures now carry only `ok:false`, `readOnly:true`,
`automaticRetry:false`, `state:inspection-failed`, a fixed `failureStage`, and up
to eight static `failureSites`. Stages distinguish source verification, transport,
receipt validation and host inspection. No exception message, stack text, local
variable, raw output, configuration value or account field is returned.

Site tokens such as `F1-L64` mean source-file index 1 in the transport's fixed
`SOURCE_FILES` tuple, line 64, at the exact workflow commit. Tokens are derived
from statement locations in the verified source bundle and checked again by the
runner. They identify executed validation code, not the underlying host cause.
Unknown locations produce an empty list. Local absolute-path frames are omitted.

Only inspection accepts a bounded, strictly validated failure receipt from a
nonzero remote exit. Restore and receipt mode retain their existing rejection
behavior. A diagnostic causes nonzero receiver and workflow exits; it cannot
satisfy preflight or authorize retry. Administrative-route, exact-source CI,
first-attempt, concurrency and separate restoration/secret gates remain in force.
The previously captured generic failure cannot be diagnosed retroactively. A new
inspection needs coordinator review after this change passes exact-source CI.

The runner transport additionally reports fixed `transport-*` categories for
missing/denied/unavailable subprocess startup, timeout, output overflow, closed
stdin, I/O failure, signalled/nonzero exit, absent/invalid failure receipt, and
cleanup failure. Receipt validation after a zero exit remains a separate stage.
No exit number, exception text, stdout or stderr is exposed. A broken stdin pipe
does not hide an already-failed child's exit: output is drained within the same
limits before classification. Failure never authorizes an automatic retry.

The pinned Tailscale action installs `/usr/local/bin/tailscale`; its v1.94.2 SSH
wrapper calls Go `os.UserConfigDir()` to write public SSH host keys. On Linux,
that function fails when both `XDG_CONFIG_HOME` and `HOME` are absent. For only
the fixed Tailscale SSH target, the transport supplies a fresh private temporary
`XDG_CONFIG_HOME`, removed after subprocess cleanup. It never inherits runner
HOME/configuration, auth sockets, tokens or passwords. The directory contains
only Tailscale's public host-key file; requests still travel through private
stdin. Other subprocesses retain the original restricted environment.

This source-level dependency explains a deterministic failure in the old child
environment, but the historical generic transport receipt cannot prove which
failure occurred on that runner. No raw historical stderr is recoverable from
the receipt. These diagnostics and environment handling are locally tested;
another host inspection still requires the existing exact-source and access gates.

For the file-timestamp guard only, an inspection failure may include a
`timestampFailures` list. It contains at most eight unique, sorted pairs drawn
from four categories (`runtime-revision`, `runtime-source`, `service-unit`,
`environment`) and two comparisons (`mtime-after-process-start`,
`ctime-after-process-start`). Multiple source files collapse into the same
category; no filenames, counts, paths, timestamps, inode values or configuration
contents leave the receiver. Other failure stages and restore/receipt modes
reject these details. Receiver and workflow still exit unsuccessfully.

The predicate is unchanged: each observed modification/status-change timestamp
must be no later than the calculated process start. Equality still passes and no
tolerance is added. The calculation combines whole-second `/proc/stat` boot time
with process-start clock ticks, so it is not nanosecond-precise despite its units.
A synthetic near-start example demonstrates possible precision-related rejection,
but does not identify the live host's cause. A ctime comparison alone also does
not establish a content change. The diagnostic is an observed comparison, not
permission to restart, alter files, or weaken the guard. It stops before runtime
content, environment content, production inventory or account-state validation.

On an environment timestamp failure, inspect mode alone may attach
`environmentTimestampEvidence`. The collector reads only three fixed systemd
Service properties using bounded `/usr/bin/busctl --system get-property`:
`MainPID`, `ExecMainPID`, and `ExecMainStartTimestamp`. Both PIDs must match the
observed process. Two identical property samples, repeated process-start ticks,
and unchanged protected environment-file metadata are required. Missing tooling,
malformed output or changing evidence yields only `state: unavailable`; the
original guard failure is still raised. Restore/receipt mode does not perform
these additional reads.

Observed evidence contains one or two fixed comparison records, matching only
the failed environment mtime/ctime comparisons. Each reports whether the positive
gap is within or beyond the nominal quantization budget of one second plus the
ceiling of one clock tick, and whether it is before, within the recorded
microsecond, or after systemd's recorded service-start event. No raw timestamp,
delta, PID, path, contents or command output is returned. These labels never
change admission, trigger retry, or authorize a restart.

Within-budget and before/within the recorded event is consistent with truncation,
not proof of a precision-only false positive. Beyond-budget and after the event
cannot be explained by that quantization alone assuming a stable wall clock.
Other combinations are inconclusive. systemd records a supervisor event after
spawning/adopting the process, not exact kernel birth; its timestamp is explicitly
not a replacement guard. Wall-clock adjustments can also alter Linux's boot-time
reference, so these observations cannot establish historical chronology or prove
file-content modification. Full runtime, environment and cohort validation
remains blocked in every diagnostic outcome.

Evidence semantics: [systemd service API](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.systemd1.html),
[busctl property reads](https://www.freedesktop.org/software/systemd/man/latest/busctl.html),
[systemd recorded process start](https://github.com/systemd/systemd/blob/v255/src/core/execute.c#L1793),
[Linux proc boot-time serialization](https://github.com/torvalds/linux/blob/v6.8/fs/proc/stat.c#L175),
and [Linux boot wall-time behavior](https://github.com/torvalds/linux/blob/v6.8/kernel/time/timekeeping.c#L2236).
