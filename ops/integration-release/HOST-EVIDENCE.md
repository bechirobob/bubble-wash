# Host materialization contract

PLAN-TEMPLATE.json is intentionally incomplete and cannot execute. It contains no fake release SHA, invented database path, invented unit source or approval boolean. Filling it is a separate host-read/approval operation, not performed here.

Each unit entry must contain:
- properties: exact WorkingDirectory, EnvironmentFiles, User, Group and FragmentPath strings as loaded by its correct system or ubuntu user manager.
- execStart: for each service only, an array of {path, argv, ignoreFailure} from typed D-Bus ExecStart. Runtime timestamps/PID/exit codes are validated then discarded.
- files: complete mapping of FragmentPath and every effective drop-in path to SHA-256.
- dropins: exact effective drop-in path to SHA-256 map. All gate paths and their parents must be root-controlled; no pending daemon reload is allowed.
- fragmentUid: for the user service only, the observed root or ubuntu uid of the unchanged fragment.
- cgroup: for the two services, the exact reviewed manager cgroup path, retained for stop checks even if systemd clears it afterward.

inventoryPaths must include all required cron/at/container paths, the system/global-user/vendor/transient/generator unit trees, all account user unit configuration paths, and active user managers' runtime source trees. Missing roots are recorded explicitly as absent; symlinked files bind the exact target and content, including masked /dev/null units. Unknown source paths or directory links require review, not automatic traversal acceptance.

The root-controlled exclusion receipt has exactly these keys:
- schema: bubblewash-host-invoker-review/v1
- hostMachineIdSha256 and bootId: the actual target host and current boot
- issuedAt and expiresAt: integer UTC epoch seconds, at most 1800 seconds apart
- sourceContractSha256: the exact source-contracts.json digest
- inventorySha256: canonical sorted JSON SHA-256 of Host.inventory()
- excludedInvokers: exactly [root-direct, ubuntu-direct, other-users, cron-at, alternate-systemd, containers, remote-triggers]
- reviewReference: SHA-256 of the separately approved bounded invoker-review evidence

The exclusions are an explicit review of launch authority for this transition, not security enforcement against a privileged actor. Never fabricate a receipt from test fixtures or merely copy the required category list without reviewing actual evidence. This package does not generate approval receipts.

Protect staged plans and packages under /var/lib/bubblewash-release/plans and /var/lib/bubblewash-release/packages/<plan_id>, respectively. The workflow bootstrap rejects writable ancestry, extra files, symlinks, special objects and all bytecode/cache artifacts before import. No source-contracts.json or imported code may be writable by the app user. The plan ID is a reviewed 64-hex package identifier, independent from the exact plan SHA-256 input.

Owner evidence must describe the already-reviewed candidate AND fallback behavior, including owner capability/MFA preservation and enrollment compatibility. materialize_plan.py copies its digest, pins the exact owner source files, verifies real clean Git bindings, hashes all built runtime and installed dependency objects and captures the existing database inode. It does not confer approval or write anything to a host.

The old database and its snapshots remain outside all code roots. The existing original guard binds lock/config/database marker/backup status and encrypted archive receipt. Never replace a stale receipt or failed pin with an invented value; stop for renewed evidence and review.

Recovery after reboot/receipt expiry keeps the same immutable installed package path and plan ID, because controllerPins binds those absolute paths. Renew only the exclusion receipt/path/digest and encrypted-backup receipt/run/archive evidence, then independently review the new FULL host-plan digest. durable_plan() excludes only those expiring evidence fields; candidate/fallback, source/runtime/dependencies, owner evidence, Node, DB inode/path, environment digest, gate units and adapter bytes remain journal-bound. Configuration drift needs explicit separate reconciliation, not a receipt renewal.
