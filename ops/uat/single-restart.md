# One isolated UAT restart

This control requests one restart of the existing `bubblewash-uat.service` through
its existing protected environment/admin route and `bubblewash-production` lock.
It never uses activation, deploys code, changes unit/environment/firewall settings,
handles credentials, or queries/mutates accounts. The normal application may write
its existing data during startup/traffic; this is not a byte-preservation tool.

Before dispatch the coordinator must record the owner's specific single-restart
approval, reserve a quiet window with host/account operators, confirm exact main
CI and release gate, and record the unique operation ID and resulting run. The
flags attest these facts; they do not establish them. Public traffic is not
technically blocked. Two empty established-connection samples do not prove future
traffic exclusion. Requests can fail during the approved interruption.

The collector's restart precheck accepts only the known environment-file timestamp
obstruction and verifies all other runtime/configuration/isolation evidence. Its
result is private host evidence, never account admission. Normal inspection,
restore and receipt retain their existing timestamp guard. Restart postcheck
uses that exact guard with no exception and all host isolation checks, excluding
account inspection. A separate read-only cohort preflight remains necessary for
any later account operation.

Loaded service commands, hooks and propagation dependencies are checked before
requesting restart. The command uses `--job-mode=fail` to avoid replacing competing
systemd jobs. It is issued once, with a 45-second client bound. Existing
Restart=on-failure remains active; automatic service recovery is not another
operator request. Postchecks poll read-only for startup for up to 30 seconds, and
the remote process has a 150-second ceiling. Startup cannot be guaranteed within
these bounds. A successful systemctl result alone is not readiness.

The workflow rejects reruns and shares the existing lock. This is NOT durable
exactly-once execution across distinct workflow dispatches: the coordinator must
not dispatch twice for the same approval. No marker is written on the host. On
uncertain output, cancellation, timeout or failed postcheck, inspect the run and
host state; never retry/restart automatically, stop the service, reset-failed or
change settings. There is no automatic database restore or process rollback.

Receipts contain only a closed state and boolean fields. `precheck-failed` means
no restart request was sent by that host invocation. `restart-uncertain` means
request/transport outcome cannot be inferred. `postcheck-failed` means the request
returned successfully but verification did not complete. `verified` means a new
process passed unchanged host timestamp/isolation checks and non-database health.
No receipt permits credential issuance or claims the original accounts restored.

Implicit dependencies are bounded separately from propagation relationships.
`Requires` permits only the existing active sysinit target/system slice and an
optional existing active root mount. `Wants` permits only systemd's implicit
`tmp.mount`: it must already be mounted at exactly `/tmp`, or be verified
masked/not-found, inactive/dead and without a job, so it cannot activate.
An inactive loadable mount is refused. Mount identities are checked against exact
PID1 mount entries; dependency identity, configuration metadata and state are
compared across both prechecks and postchecks. No arbitrary mount/dependency is
accepted, and Upholds/UpheldBy relationships are refused. Missing/unsupported
properties fail closed. The reserved window must exclude unit-file/configuration
changes; this control does not lock out privileged operators.

The workflow now defaults to `inspect`, a structurally separate read-only path.
It repeats the same restart prechecks without entering the restart function or
calling health/account operations. The receipt contains only a fixed stage and
source-statement tokens derived from the exact transmitted Python sources.
Exception text, values, paths and stack details are never returned. Even when
`precheckPassed` is true, diagnostic `ok` remains false: this is not historical
chronology proof or account admission. A restart still requires explicit
`mode=restart` and both original restart/quiet-window attestations. An unavailable
diagnostic never authorizes a retry of a mutation-capable control.
