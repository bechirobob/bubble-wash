# Encrypted, read-only host facts

This small manual inspection is not a deployment, preparation installer, readiness
check, backup, or operator-exclusion receipt. Publication and the first run require
approval of this specific infrastructure-data purpose and private destination.
It does not change services, settings, permissions, directories, databases, owner
accounts, email, keys, or release pointers. SSH access can produce ordinary audit
records. No prior inspection package is reconstructed or claimed equivalent.

## Collected facts

The three existing BubbleWash units are queried for load/active/reload state,
fragment/drop-in paths, service identity, working/root directories and main PID.
No Environment values, ExecStart arguments or process command lines are queried.
EnvironmentFiles path metadata is queried to check the known app binding, without
opening those files. Identified unit/drop-in files are hashed as bytes without parsing or
reporting their contents. Their metadata and ancestor ownership/permissions are
recorded. Known standard unit-source locations are inspected only for the three
unit names and their immediate drop-in entries. A running main executable is
identified through `/proc/PID/exe`; inactive executable identity remains unresolved.

The existing environment file is inspected only with stat and xattr-name presence
queries: Ubuntu owner/primary group, exact mode 0600, link count, ACL/xattr presence and
ancestor metadata. No environment contents or xattr values are read. Existing
deployment-lock identity/ancestry and fixed Python/systemctl availability are
recorded without acquiring the lock, writing or executing an installer. These
metadata facts do not prove environment parsing or installation can succeed.

Fixed application/host parent locations are checked for available bytes/inodes and
metadata. Positive free space does not establish capacity for a future package.
Missing sources, unsafe permissions, pending reload and unavailable facts produce
fixed flags, not a healthy inference. Unit file hashes are race-checked but this is
not a coordinated exclusion window or an exhaustive alternate-launch inventory.

The unchanged PHP collector reports allowlisted installed PHP package versions,
PHP/nginx/Apache service metadata, PHP-named process counts and TCP binding classes.
It never executes PHP, reads web configurations or probes websites. Mutable/truncated
process names, missing tools, containers/custom installs, embedded Apache modules,
UNIX sockets, routing/firewall/reachability and distro backports remain unverified.
No-PHP-detected is not a claim of absence or a vulnerability verdict.

All concrete paths, UIDs, ownership, versions, executable/source metadata and full
PHP results stay in the encrypted report. Public output is only the allowlisted
summary result/flags and ciphertext SHA-256. It contains no paths, usernames,
versions, raw subprocess output, account/customer data or keys. Fixed flags describe
observations and gaps; they are not deployment acceptance.

## Encryption and storage

The host reads the existing private backup key file, without moving it, changing
it or generating a key. Ancestors must be root/application-owned and not writable
by group/others; the regular single-link key must be private and canonical 32-byte
base64. Reads are bounded and identity/timestamps rechecked. The Node executable
and ancestry must be protected. Failure does not relax these checks.

The existing AES-256-GCM pattern is purpose-separated with an HMAC-derived key and
the distinct `BWHFACT1` format. A fresh random 96-bit nonce is used. The canonical
public header, source commit, run ID/attempt and summary are authenticated as AAD.
The original report bytes are encrypted without JavaScript reserialization, so
64-bit metadata is not rounded. Neither key nor plaintext enters runner arguments,
environment, logs, plaintext artifacts or public storage.

The manual workflow uses the existing pinned Tailscale action, root SSH transport,
backup-storage environment and destination-only token. The pinned existing backup
transport's API/privacy/asset-validation primitives are source-loaded, not imported
from bytecode. A separate host-facts release tag and schema are used. Exactly the
encrypted asset and checksum are uploaded to the existing private becore-backups
repository, independently downloaded/hashed before publication, with privacy and
pinned storage-commit checks repeated. No backup receipt, restore proof, local
backup-status change, expiry or cleanup is performed. Uncertain mutations are not
retried or deleted; a failed private draft may remain for inspection.

Both subprocess pipes, input/report size, command duration and process groups are
bounded. The host sets its own 150-second deadline; the runner stops local SSH at
180 seconds. A network disconnect does not prove immediate remote termination.
No remote mutation or persistent workload is started.

## Private retrieval

Read-only retrieval requires access to the existing private store plus the exact
public source SHA, run ID/attempt and existing store ID/commit. It verifies repository
privacy, tag/commit, the exact two assets, hashes and authenticated context before
exclusive private local output. It never exports a decryption key. Decryption is
an explicit local action using an already-authorized private key file, and writes
a new mode-0600 file only. It never prints plaintext or raw exceptions.

The private output is two JSON lines: authenticated public header, then original
report JSON bytes. Retain it only in an approved private location. Sharing the full
report is a separate action, not implied by inspection approval.

## Local verification and integration

Run the workflow's three test commands before publication. Tests use synthetic
metadata/processes, fake private APIs and generated disposable test keys. They do
not inspect the live host or call providers. This nine-file overlay relies on the
existing exact backup primitive file in the reviewed application checkout; copy
that unchanged dependency only into disposable local test assemblies if needed.
Final exact candidate source/control pins must include these additions through
the existing reviewed profile reconciliation, not a broad allowlist exception.

## Fixed public outcome flags

The summary adds exactly one flag from each pair:
- `php-indicators-observed` or `php-no-indicators-observed-incomplete`. Package,
  PHP service, named-process or TCP-listener evidence can establish the first;
  the second never proves PHP absence. Neither is a vulnerability verdict.
- `installer-metadata-preconditions-observed` or
  `installer-metadata-preconditions-unverified`. The positive requires the exact
  loaded service/environment binding, app UID and primary GID, a single-link
  mode-0600 environment file without xattrs/ACLs, canonical protected ancestors,
  safe existing deployment-lock metadata, and root-owned protected executable
  resolution for both fixed tools. The lock is not acquired. The environment is
  not opened or parsed. Installer execution can still fail and has not happened.

All earlier gap flags remain. No path, version, username, count, raw metadata or
secret-derived value is placed in the public summary. These flags do not certify
maintenance-plan safety, exclusion, capacity, application readiness or migration.
The detailed encrypted report and its host-held decryption key are not exported.


## Private bounded diagnostic observations

The optional `diagnostics` object is projected from the same collection before encryption, validated in Python and Node, authenticated in the existing encrypted envelope header, and retained only in the authenticated header of the asset stored in the private backup repository. Public workflow output strips the entire diagnostics field and retains only the original coarse schema/result/flags and ciphertext digest. There is no extra plaintext report, key export, new command, or unauthenticated pre-encryption log line.

- `environment` has eleven fixed boolean-or-null predicates: account validity, regular file, expected owner and primary group, exactly private mode, single link, canonical path, directory ancestry, allowed ancestor owners, non-writable ancestor modes, and absent extended attributes. Null means unobserved. No numeric owners, groups, modes, paths, attribute names, or environment values are included. The installer aggregate retains every previous predicate; these observations authorize no permission change.
- `units` has exactly three fixed aliases in order: maintenance timer, maintenance service, application service. Fixed stage categories distinguish unavailable account, command failure, invalid properties, and inspected properties. Separate unit-source and running-executable categories distinguish not assessed, trusted ownership, unsafe ownership, and read/validation failure. Property parsing distinguishes missing, duplicate, unknown, malformed, and oversized data; only missing property names from the existing fixed property allowlist are retained, never unknown keys or values. These are coarse observations, not raw exception messages or proof of manager readiness.
- `php` includes at most 24 installed package name/version pairs from the existing inventory, constrained to PHP metapackages, versioned PHP packages with the fixed common-extension suffix allowlist, and the Apache PHP module. Versions have a bounded package-version alphabet. Unrecognized packages remain only in the encrypted report; `packagesComplete` is false if filtering or truncation occurs. Service and listener observations are boolean or null, not counts, addresses, ports, process IDs or executable identity claims. False observed presence does not prove PHP absence or external safety.

Detailed metadata and all existing gap flags remain encrypted or unchanged. No permission, service, credential, installation, database, or maintenance mutation is added.

### Private fixed-unit binding refinement

Each fixed unit's private diagnostic includes an optional canonical absolute WorkingDirectory, at most two parsed EnvironmentFiles path/ignore-errors pairs, and an optional MainPID executable path plus SHA-256 already collected by the existing source inspection. Paths use a conservative ASCII alphabet, a 256-character bound, and reject relative paths, traversal, duplicate separators and control characters. Unsupported forms remain null, not fabricated bindings. Only already-observed binding properties are retained when unrelated service-only properties are missing on a timer; this does not make the existing installer binding aggregate succeed.

The fixed identity scope is `main-pid-not-listener-identity`: MainPID may be a launcher, and this is not evidence of the listening Node executable, its version, the configured database path or database schema. Use the separately reviewed release preflight for those facts. No extra process reads, argv, environment values or commands are collected. Existing 7000-byte summary and 8192-byte authenticated-header limits still fail closed. All binding fields stay in the private authenticated header; both public output paths remove the entire diagnostic object.
