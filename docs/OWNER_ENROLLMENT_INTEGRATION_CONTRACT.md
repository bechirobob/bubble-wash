# Exact owner-enrollment source selection after the website integration

This is a source-acceptance change, not an owner invitation, a provider readiness
claim, or authorization to change accounts, credentials, environment, mail routing,
permissions, or the running service.

## Separate contracts

The historical `ops/owner-enrollment-source-pins.json`,
`ops/deploy-personal-owner.py`, and `ops/check-owner-source.py` stay byte-for-byte
unchanged. In particular, the historical owner deployment guard must continue
rejecting the refreshed website and fallback. Its initial-owner deployment and
rollback restrictions have not been loosened.

`ops/owner-enrollment-integration-pins.json` contains exactly two separately
selected records:

- `integration-candidate-v1`: the reviewed website-only integration source.
- `integration-fallback-v1`: the reviewed owner-aware recovery source, compatible
  with the additive outbox schema.

`historical-owner-v1` remains the default. There is no automatic host fallback.
An omitted selector on refreshed code is expected to fail the historical pins.
Each new profile is locked by a canonical SHA-256 in the streamed source-check
helper. It is not a bag of permitted per-file hashes: a missing, added, edited,
swapped, mixed, or unknown profile fails. Both records must validate before the
runner streams an integration profile.

The complete `src`, `public`, and `db` file sets are checked, including rejection
of additions, removals, links and special files. The package manifests, Next and
TypeScript configuration, unchanged invitation script, migration script,
historical owner acceptance tests, and added outbox compatibility/invitation
tests are individually pinned. Parent-directory links are rejected too.

The unchanged authentication, mandatory personal-MFA, account store, login and
enrollment routes, password/encryption code, staff identity, invitation transport,
and dependency lock retain their historical digests. The refreshed data-store
initializer and exact outbox-schema helper are pinned as part of each full source
combination. The fallback uses the same owner-aware security boundaries; it is
not a return to pre-owner authentication code.

## Runner identity is not deployed-target identity

The manual, protected, main-only enrollment workflow verifies its trusted checkout
with `ops/check-owner-enrollment-source.py --verify-runner`. This read-only runner
check must match exactly one known source contract. It does not choose the host
contract. Main can remain the candidate when the running service has recovered to
the separately reviewed fallback.

The operator explicitly selects `source_contract`; that exact selector and one
locked profile are streamed to the host. The host first verifies the independently
supplied deployed release SHA, then the selected source. It rechecks both under
the existing shared deployment lock immediately before the invitation child.
Passing the runner check does not imply that the deployed release matches.

`appInputGitTree` records the reviewed application input tree before adding these
controls. It is provenance, not a fabricated final commit or deployment identity.
The separate release adapter must bind the fully assembled controls and app source
to a real publication SHA/tree and validate its own runtime manifest. These
enrollment profiles intentionally exclude control/workflow metadata, generated
builds, node_modules and live data. That avoids recursive manifest hashing and
does not replace the release adapter's broader source/runtime guards.

## Unchanged execution boundary

The default remains check-only, with delivery approval false. Protected recipient
and dedicated owner transport secrets remain private. Separate actual approval,
provider/sender verification, valid personal MFA key, duplicate-account checks,
recent backup proof, production proof, lock identity, and bounded single-attempt
execution are still required. This change does not install a key, call Resend,
send an invitation, create an account, or dispatch the workflow.

Synthetic tests establish source selection and preservation behavior only. They
are not evidence of live host acceptance, delivery, activation, or real-account
login. After an uncertain send, stop and inspect privately; do not automatically
retry, reset, replace, downgrade, or delete an account.

## Read-only validation

Run the selected source check using an actual checkout path:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 ops/check-owner-enrollment-source.py --verify-runner
PYTHONDONTWRITEBYTECODE=1 python3 ops/check-owner-enrollment-source.py \
  --source-contract integration-candidate-v1 --release /absolute/candidate
PYTHONDONTWRITEBYTECODE=1 python3 ops/check-owner-enrollment-source.py \
  --source-contract integration-fallback-v1 --release /absolute/fallback
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s .github/backup \
  -p 'test_owner_enrollment*.py' -v
```

The backup-transport CI path filters and exact integration runner selector must
include this helper, checker, profile file, tests, documentation, and workflow.
Do not replace the historical deployment guard with the integration selector.
