# Second UAT cohort: local preparation only

Initial base: `a9cf60982ed5efdfc6e77f58156df56ca2995a87`.
Reconciled locally with current main `a277bfa321fe153d554675903ddb14afd8316193`
(PR #161, bounded isolated UAT restart). Normal second-cohort collection continues
to enforce timestamp and account checks; it never uses the restart-only precheck.
Only the generated runner manifest conflicted and was recomputed. Publication
remains on hold after the coordinator reported a pre-admission authorization denial.

`scripts/uat-second-cohort.mjs` is an operator module, with no CLI, HTTP endpoint,
workflow, or host transport. Installing/importing it does not issue accounts.
It does not change the first-issuance or restoration guards.

## Contract

The caller supplies a dedicated SQLite handle for the existing UAT database.
The module checks its real filename against the path validated by
`assertUatEnvironment`. Do not use `getDatabase()` to obtain the operational
handle: it performs unrelated initialization and history cleanup. The eventual
adapter must open the existing file only, with foreign keys, a bounded busy
timeout, and no migrations/housekeeping, and close it when finished.

`secondCohortState(db)` returns an opaque SHA-256 precondition covering existing
accounts, audit, operational rosters and the original handover. Capture it from
a consistent read transaction when preparing a concrete operation.

`issueSecondCohort(request, db)` requires:

- `approved: true`, `ready: true`, supplied only after external action-time
  authorization and verified UAT isolation; these booleans are not evidence.
- A UUID-v4 `operationId`, the captured `expectedStateSha256`, and the recipient's
  RSA public key (`publicKey`, minimum 3072 bits).
- Integer epoch-millisecond `notBefore` and `approvedUntil`, spanning at most
  five minutes. The approval must remain valid through commit.

Under one immediate transaction it checks the state, original four `review-*`
identities and bindings, absence of any reserved `review2-*` identity and absence
of the second-handover table. It generates four random passwords in process,
uses `issueUatCohort` to hash/issue all four roles, and stores the encrypted
handover in `uat_second_cohort_handover` with its operation binding. The accounts
and encrypted handover commit together. Account expiry is exactly 604800000 ms
from issuance. Old accounts, including revoked/expired accounts, roster records,
business data and original audit/handover records remain unchanged.

The returned value is an existing-format RSA-OAEP/SHA-256 + AES-256-GCM envelope.
Its authenticated plaintext contains second-cohort schema, operation ID,
precondition digest, recipient fingerprint, origin, timestamps and accounts.
The recipient MUST verify the authenticated schema, operation ID and recipient
fingerprint against independently retained operation details before using the
credentials. The state digest is authenticated inside the ciphertext; if an
independently retained digest is available, the unseal helper also compares it.
Outer metadata alone is insufficient.

`retrieveSecondCohort(request, db)` uses the same approval/readiness, operation and key fields but not the issuance
time window. The original state digest is optional for recovery (and checked if
supplied), so a lost runner session does not make persisted ciphertext unrecoverable. It retrieves the exact
persisted ciphertext without issuing accounts, changing their status or extending
expiry. A repeat issue always fails, even with a new operation ID. An existing
empty receipt table or reserved identity without a receipt is uncertain state:
stop and investigate; never remove records to make issuance proceed.

## Validation and review

The new integration test uses only a disposable temporary database and ephemeral
synthetic RSA keys/passwords. It exercises atomic four-role issuance, exact seven
days, authentication and roster bindings, old/revoked/expired data preservation,
unrelated submissions/history preservation, stale roster/audit preconditions,
approval/clock guards, wrong recipient and tamper rejection, encrypted operation
binding, repeat/recovery behavior, uncertain receipt rejection, and rollback
including a failure at final receipt insertion. It is included in `npm run test:uat`.

Independent review found and resolved default database housekeeping and explicit
handle/path-binding risks. The reviewer independently passed the new integration
test and reported no remaining blocking findings for this local-only module.

## Prepared minimum integration

- `scripts/uat-second-cohort-operator.mjs`: bounded request adapter with existing-file
  SQLite open, no housekeeping, device/inode/open-descriptor checks, read-only
  inspection/retrieval and an outer issuance transaction.
- `ops/uat/second-cohort-receiver.py`: current isolation collection before and after
  each operation, unchanged timestamp guards and existing sandbox properties.
  `eligible=False` skips only eligibility to restore the original passwords.
- `ops/uat/second-cohort-transport.py`: exact-source administrative caller using the
  existing bounded Tailscale SSH exchange to `root@hermes`. Reviewed operator source
  is loaded in memory; no app deployment, account reset, or runtime file overwrite.
  Its direct CLI remains disabled. The separate protected workflow below is
  prepared locally but is not published or dispatched.
- `perform_private_handoff` verifies the existing private storage repository before
  issuance and uses the unchanged first-handover publisher for ciphertext only.
  It binds only a separately loaded publisher instance to the approved second-cohort
  recipient. The historical recipient and first-issuance host guards are unchanged.
- `scripts/uat-second-cohort-unseal.mjs`: authenticated recipient-side decryption and
  exclusive mode-0600 output in a caller-owned directory with no group/other access.
  It never generates keys, sends data, or prints plaintext.

## Concrete invocation after the hold is lifted

The callable sequence below is implemented by the locally prepared
`.github/workflows/uat-second-cohort.yml` and `ops/uat/second-cohort-runner.py`.
Neither is published/dispatched; this is not permission to execute now.

1. Verify successful CI for the exact reviewed main control commit using existing
   `ops/check-release-ci.py`. Keep `backup-storage`, first-attempt/exact-main guards,
   approved existing Tailscale identity and `bubblewash-production` concurrency.
   Import the exact reviewed `restoration-transport.py` under module name
   `uat_restore_transport`, then `second-cohort-transport.py`. Never reroute after
   a denial.
2. Require coordinator approval for this operation UUID, four fresh roles, exact
   runtime/control source, approved one-operation recipient key and private storage/delivery.
   Establish that the recipient actually possesses the matching private key BEFORE
   any issuance. Do not infer this from a public key or old storage receipt.
3. The runner receives only the nonsecret approved operation UUID and public key;
   no old/new passwords or private keys enter workflow inputs or secrets. Set the
   action-specific attestations only after real authorization. Call
   `snapshot = transport.perform(root, env, {'action': 'inspect'})` privately.
   This invokes the unchanged live collector; any failure stops the operation.
   Keep the digest in memory, never logs or workflow output variables.
4. In the same authorized runner execution build the request below, then call
   `transport.perform_private_handoff(root, env, request)`. The five-minute window
   is measured from the host inspection. This wrapper returns only the existing
   nonsecret storage receipt; only that receipt may be logged.

```python
request = {
    'action': 'issue', 'approved': True, 'ready': True,
    'operationId': approved_operation_uuid,
    'publicKey': verified_second_cohort_recipient_public_pem,
    'expectedStateSha256': snapshot['stateSha256'],
    'notBefore': snapshot['inspectedAt'],
    'approvedUntil': snapshot['inspectedAt'] + 300000,
}
receipt = transport.perform_private_handoff(root, env, request)
```

Required runner context is the existing exact-main/first-attempt workflow context
and `SOURCE_SHA`; new explicit attestations are `ADMIN_ROUTE_APPROVED`,
`PRIVATE_HANDOVER_APPROVED`, `RECIPIENT_KEY_VERIFIED`, and, for issue only,
`SECOND_COHORT_ISSUANCE_APPROVED`, all `true`. Existing publisher context also
requires `MODE` (`issue` or `retrieve`), `RUNTIME_SHA`, `HANDOFF_PUBLIC_KEY`
(base64 SPKI DER), `ISSUANCE_APPROVED`, `HANDOVER_READY`, `BACKUP_STORE_SHA`,
`BACKUP_STORE_ID`, run ID and the already-supported `GH_TOKEN` binding. These are
requirements, not evidence that bindings/authorization are presently available.
Do not inspect denied secret metadata or add credentials to establish them.

On an uncertain host/transfer/publication outcome, stop. A separately approved
recovery uses the SAME operation UUID/public key, action `retrieve`, approval and
readiness flags, with no issuance time window or required state digest. It returns
the persisted ciphertext and cannot create accounts or extend their expiry.
Do not retry issue, delete the handover table, or choose another operation UUID.

Download the encrypted asset using existing authorized private-storage access,
verify its checksum against the storage receipt, and decrypt on the approved
private recipient side. Call `savePrivateHandover(ciphertextBuffer, privateKeyPem,
{operationId, recipientSha256}, approvedDestination)` with the independently
retained UUID and verified recipient fingerprint. The original state digest may
also be supplied if privately retained. The helper authenticates the complete
payload and writes no plaintext stdout. Deliver that file only through a verified
user-only path; the user distributes it. A local mode-0600 file alone does not
establish a user-facing delivery channel.

## Outstanding prerequisites / deadline risk

- The coordination hold is active: separate restart/isolation work must complete,
  and the coordinator must explicitly authorize the live issuance action.
- The runtime pin remains `f4fd4ce424c2b363fc5a2196432e0ac2ce7c05a1`. A changed
  runtime needs independently reviewed pins; never derive approval from whatever
  files happen to be on the host. Timestamp failures remain fatal.
- Publication of this local control code and exact-main CI, plus a reviewed
  protected runner workflow are not authorized/completed. The missing step is now
  implemented locally; the existing first-issuance workflow remains unchanged.
- The user separately authorized the one-operation delivery key documented below.
  Its local custody is verified. Keep this selected environment and protected key
  directory intact until successful verified handover; do not replace or delete early.
- Existing private-store authorization/bindings and user-only final delivery are
  not verified. Local mocks do not establish remote access.

The 16:00 UTC+1 / 15:00 UTC deadline remains at risk until those gates are resolved.
No host contact, real account credentials, workflow dispatch, deployment, publication,
remote security-setting changes, or denied secret/log endpoint access occurred here.
The only live cryptographic material created is the separately authorized local
one-operation delivery key described below.


## Prepared workflow confirmation scope

The new workflow has ten inputs: exact `source_sha`, retained `operation_id`,
approved second-cohort `handoff_public_key` (public DER only), `mode` (`issue` or
`retrieve`), and six false-default attestations. Every attestation must be true:

- `admin_route_approved`: existing administrative route approved for this action.
- `operation_approved`: restart/isolation work passed and coordinator authorized
  this precise issue or recovery, UUID, four roles, reviewed code and target.
- `private_handover_approved`: existing private encrypted release storage approved.
- `recipient_key_verified`: matching approved one-operation private key is demonstrably available
  to its authorized holder outside the runner. Public-key presence is insufficient.
- `private_retrieval_verified`: authorized private asset download capability has
  been established without denied log or secret-metadata endpoints.
- `user_delivery_verified`: final user-only delivery route is established.

The local `--check` rejects missing gates, mismatched source, reruns, debug modes,
wrong recipient and unsupported context before Tailscale is invoked. It reports
only local gate acceptance, not independently verified key custody or handover
readiness. The real step recollects live isolation and rejects any failed check.
The state digest stays in runner memory. Neither private keys nor passwords are
workflow inputs, environment secrets, artifacts or output variables. Only the
existing validated nonsecret encrypted-storage receipt is printed.

Publication scope is this branch's reviewed patch plus refreshed runner-only
source commitment, followed by exact-main CI. No new persistent access, token,
remote secret, storage repository or transport route is introduced. The explicitly
authorized recipient pin applies only to the separate second-cohort path. The
existing protected environment and three existing secret bindings remain required:
Tailscale OAuth ID/secret and `BACKUP_STORE_TOKEN`; their availability is unverified.
If any binding/access/key is missing, stop and seek specific authorization; do not
create or broaden it. A replacement key/pin, new storage destination, permission
expansion or alternative transport would be a new action requiring confirmation.


## Authorized one-operation key custody

The user explicitly approved creating a new delivery encryption key because the
original key could not be located, using it for the four fresh test logins, and
removing it only after successful verified handover.

- Operation UUID: `ba2a58a3-d37f-4a20-985c-1f7fcbbf2aef`.
- Public SPKI SHA-256: `dc87a41bd34beee0dd64bb165ae968ea266b84ac9b86fe8d642e5ffbdcb6c154`.
- RSA-3072; custody verified at `2026-11-04T13:15:50.635Z` by reopening the retained key
  and completing an RSA-OAEP/SHA-256 encrypt/decrypt roundtrip locally.
- The private key is outside the repository, in a caller-owned mode-0700 directory;
  its file mode is 0600. No private key bytes are in this source, patch, workflow
  input, log, message or public artifact.
- Issuance and retrieval both reject any other operation UUID or recipient key,
  including calls through the lower-level transport helper.
- The historical first-issuance fingerprint and original handover are unchanged.
  A separate loaded publisher instance receives the second-cohort pin; it cannot
  modify a first-issuance instance.

Custody evidence and the public dispatch input are retained with the private key
in the selected execution environment. The key is NOT deleted yet: successful
handover has not happened. No automatic deletion is attached to failed issuance,
transfer, publication or verification. After the user-only handover is verified,
remove the retained private key under the user's approval and record only a
nonsecret cleanup receipt. Recheck custody immediately before issuance; this
record does not establish remote storage retrieval or final delivery readiness.
