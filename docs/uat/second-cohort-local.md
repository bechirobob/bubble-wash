# Second UAT cohort: local preparation only

Base: `a9cf60982ed5efdfc6e77f58156df56ca2995a87` (origin/main inspected at preparation).

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
  Its CLI remains disabled and no new workflow is installed.
- `perform_private_handoff` verifies the existing private storage repository before
  issuance and uses the unchanged first-handover publisher for ciphertext only.
  It retains the existing recipient pin and never uses first-issuance host guards.
- `scripts/uat-second-cohort-unseal.mjs`: authenticated recipient-side decryption and
  exclusive mode-0600 output in a caller-owned directory with no group/other access.
  It never generates keys, sends data, or prints plaintext.

## Concrete invocation after the hold is lifted

This is the callable sequence for a separately authorized, exact-source protected
runner step, not an enabled workflow or permission to execute now:

1. Verify successful CI for the exact reviewed main control commit using existing
   `ops/check-release-ci.py`. Keep `backup-storage`, first-attempt/exact-main guards,
   approved existing Tailscale identity and `bubblewash-production` concurrency.
   Import the exact reviewed `restoration-transport.py` under module name
   `uat_restore_transport`, then `second-cohort-transport.py`. Never reroute after
   a denial.
2. Require coordinator approval for this operation UUID, four fresh roles, exact
   runtime/control source, existing recipient key and private storage/delivery.
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
    'publicKey': verified_existing_recipient_public_pem,
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
  protected runner step invoking the sequence above, are not authorized/completed.
  The existing first-issuance workflow cannot be dispatched for this operation.
- Existing private recipient fingerprint is
  `a479abb3611e11c65eb89e1a437577873e26798161e284572e0bf29ccdc8b4c9`.
  Matching private-key availability has NOT been verified. If unavailable, stop;
  do not relax its pin or generate a live replacement key under this authorization.
- Existing private-store authorization/bindings and user-only final delivery are
  not verified. Local mocks do not establish remote access.

The 16:00 UTC+1 / 15:00 UTC deadline remains at risk until those gates are resolved.
No host contact, real credentials/keys, workflow dispatch, deployment, publication,
security-setting changes, or denied secret/log endpoint access occurred here.
