# Additive isolated UAT host preparation

**Prepared code, not a deployed service.** Run only after exact release approval,
current capacity evidence, and independent confirmation that the new directories
are not connected to production/staging storage. Production/staging paths, users,
units, ports 3000/3001, Caddy configuration and deployment helpers are never edited.

`prepare-host.py` defaults to a read-only admission plan. It requires an absolute,
root-staged regular tar archive under root-owned, non-writable ancestry; exact
SHA-256; and the full 40-character approved revision. It reads fresh capacity data,
requires unused UAT targets/user/group/unit/port 3108, available memory >=1 GiB,
CPU count >=2 and all three load averages below CPU count. Each destination
filesystem must have >=max(4 GiB, expanded archive size + 2 GiB) free. These are
conservative admission thresholds, not a claim that existing services have spare
capacity. Stop if shared-host observation calls for more headroom.

## Release input

Build the approved candidate off-host using Node 22, its exact package lock, and
UAT public flags (payments and automated updates false). Do not compile or install
dependencies on the shared VPS. Package `.next`, production `node_modules`, `public`,
`src`, `scripts`, `package.json`, `next.config.mjs` and needed application configuration.
The operator checks minimum required files, not application completeness; the full
release gates and startup checks still apply. Strip unneeded `node_modules/.bin`
links during packaging; preserve no symlinks/hardlinks in the archive. All required
runtime files must be ordinary reviewed files. Root-level data, credentials, `.git`,
and environment files are forbidden. No production database copy.

Include `uat-build.json` with exactly these nonsecret fields:

```json
{"schema":"bubblewash-uat-build/v1","revision":"<approved full 40-character SHA>","onlinePayments":false,"automatedUpdates":false,"providerCredentialsIncluded":false}
```

This receipt is a build assertion. Verify source/configuration and secret scanning
independently; a receipt alone cannot prove the absence of secrets in arbitrary files.
The archive digest binds the artifact reviewed for that release. Limits: 1 GiB archive,
4 GiB expanded contents, 100,000 members; duplicate/path traversal/file-parent collisions,
links, device objects and privileged modes fail before installation.

## Operator stages

1. Run `python3 ops/uat/prepare-host.py --artifact <root-staged-tar> --sha256 <digest>
   --revision <approved-SHA>` for a read-only plan. Existing Node 22 and successful
   `systemd-analyze verify` are mandatory; do not replace the shared runtime.
2. Only with installation and isolation approval, add `--apply --isolation-approved`.
   Capacity, collisions and artifact digest are checked again before the first write.
   Apply creates a nonlogin `bubblewash-uat` system user; root-owned read-only app
   under `/opt/bubblewash-uat/app`; fresh UAT data/cache under `/var/lib/bubblewash-uat`;
   private config under `/etc/bubblewash-uat`; and one new unit. The new session secret
   is generated locally with 48 random bytes, stored root-only mode 0600, never printed.
   Provider credentials, real contact links, permanent owners and maintenance secrets
   are not copied. UAT booking remains paused at this stage.
3. Apply **does not** reload systemd, start/enable services, edit Caddy/DNS, seed data,
   issue accounts or start the seven-day clock. These are separate reviewed steps.
   An interrupted installation is retained; do not retry or delete it automatically.
   Inspect the failure and recover only verified newly created UAT resources.
4. Before starting, inspect the effective unit and verify kernel/systemd enforcement
   of its restrictions. The unit binds only `127.0.0.1:3108`, allows loopback IP traffic
   but denies the `connect` syscall, preventing outbound connections even to other
   local services. Inbound accepts remain allowed. The actual Next 16.4.2/Node 22
   login render, credential endpoint and authenticated admin render were exercised
   locally under an equivalent libseccomp `connect -> EPERM` filter. This is not proof
   of the target host's systemd/cgroup enforcement; verify there before exposing it.
5. Keep `/api/uat/ready` blocked until the isolated synthetic database/rosters and four
   role cohort are prepared. Issue credentials through the existing private-stdin
   operator in one cohort transaction. The receipt records actual issuance and exact
   168-hour expiry; preparation/install time must not be substituted. Child accounts
   use the same parent deadline. Never put credentials in process arguments/logs.
6. After local health/login/role/expiry and outbound-denial checks pass, a separately
   reviewed additive routing operation may expose **only** `uat.bubblewash.co` to
   `127.0.0.1:3108`. Preserve existing Caddy routes and validate before reload. No routing
   writer is included here; do not adapt production/staging helper pins in place.

The unit permits writes only to UAT data/cache, hides home directories, drops all
capabilities and new privileges, blocks namespace/privileged device access and caps
memory (384 MiB high/512 MiB max), CPU (50%), processes (128) and descriptors (4096).
A readonly application cache target is bind-mounted to the UAT-only writable cache.
No scheduled production backup, maintenance, provider or deployment job is attached.

## Tests

`python3 -m unittest discover -s tests -p test_uat_host_preparation.py -v`

Tests are local and non-mutating outside disposable fixtures. They do not create a
system user, unit, credential or deployment. Host apply remains unexecuted.

## Exact-main conditional install workflow

`.github/workflows/uat-install.yml` is manually dispatched with the exact current
reviewed main SHA and `isolation_approved=true`; first attempts only. It requires
successful exact-main CI, uses the existing `backup-storage` protected environment
and approved Tailscale `root@hermes` route, and shares the existing production
concurrency lock to prevent racing other deployment operations. It never activates
UAT or changes routing. A new dispatch after an uncertain outcome requires inspection,
not an assumption that the first install failed harmlessly.

The runner installs the exact lock with Node 22, runs UAT/type/security checks, builds
with public payments/updates/contact channels off and a disposable runner database,
prunes development dependencies, and packages `.next`, production dependencies,
`public`, `src`, all `scripts` (including sealed handover), configuration, optional
`db` and tooling. `.next/cache` and `.bin` are omitted. Package-internal dependency
symlinks are resolved only if their final target remains inside `node_modules`; all
other symlinks and cycles fail. The result contains only regular files/directories,
`SOURCE_REVISION`, and the exact build receipt. No data or `.env` is packaged.

The transport verifies source files against the exact Git commit and validates the
artifact locally before sending. A bounded receiver reads fresh capacity BEFORE
receiving bytes, creates one NEW root-private `/var/lib/bubblewash-uat-install-*`
staging directory, accepts exactly the declared size/hash, and runs the reviewed
install-only operator. Transfer, subprocess output, source sizes and execution time
are bounded. Outputs are sanitized receipts; stderr, private environment and new
session secrets are never printed. Failed staging/installation is retained for
explicit inspection. No public workflow artifact upload or new storage destination
is introduced. The host operator independently repeats source/artifact/capacity
admission before installation.
