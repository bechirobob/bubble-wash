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
The recipient MUST verify the authenticated schema, operation ID, digest and
recipient fingerprint against independently retained operation details before
using the credentials. Outer metadata alone is insufficient.

`retrieveSecondCohort(request, db)` uses the same approval/readiness, operation,
state and key fields but not the issuance time window. It retrieves the exact
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

## Execution prerequisites still pending

1. Verify fresh-start/runtime isolation against current process/environment
   evidence. Existing timestamp checks remain unchanged; do not use this module
   to bypass the unresolved live evidence failure.
2. Implement/review a minimal separate transport adapter. It must use the exact
   reviewed source, dedicated existing-file connection, action-specific operation
   parameters, bounded input, ciphertext-only output and secret-free errors.
   Do not route through or relax pristine first-issuance guards.
3. Prepare the authorized recipient's secure delivery path and retained private
   key, preserve operation details privately, and implement authenticated
   plaintext binding verification. Test transfer interruption and exact-envelope
   recovery with synthetic material before live execution.
4. Obtain specific live action-time authorization for the verified target,
   reviewed code, recipient key, state digest and operation ID. Only then invoke
   on-host random issuance; on any uncertain outcome, inspect/retrieve that same
   operation rather than issue again.
5. Decrypt through the verified private path and deliver only to the user, who
   distributes details. No old PDF passwords are needed.

The 16:00 UTC+1 / 15:00 UTC deadline is not guaranteed by this patch. Isolation,
transport and private delivery are concrete outstanding work. No host was
contacted, no real credentials/keys created, and no workflow/deployment/publication
performed during this preparation. Previously denied environment-secret metadata
and log endpoints were not accessed.
