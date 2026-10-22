# Improvements release: preserve accounts and data

This supersedes the prior fresh-start/reset plan. Release the reviewed improvements
without resetting production, migrating accounts, changing credentials, or deleting
operational records. No fresh-start inventory or apply command is part of deployment.
The historical FRESH_RESET.md procedure is inactive.

## Before release

- Verify the exact candidate SHA, CI, dependency audits, build and browser regressions.
- Verify all existing environment-backed admin/vendor/driver/support identities and
  managed accounts remain available under the existing account model. Retain passwords,
  credential versions, roster IDs, session keys, MFA and recovery state unchanged.
- Preserve invited and suspended managed rows: they intentionally shadow matching
  environment accounts. Never delete one to unlock a user. Confirm no prior hard-delete
  left a matching legacy credential that would revive a deliberately retired account.
  Unknown deletion history is a review blocker, not permission to activate accounts.
- Preserve the database, customer/operational records, staff roster, backup archives,
  existing environment file and rollback releases. Review existing deployment scripts
  before use; do not use a path that resets data, replaces credentials or disables auth.
- Verify existing backup health, private destination and encryption configuration.
  Use normal backups only; do not select the fresh_start backup option or require
  empty operations, absent legacy credentials or disabled staff auth as release gates.
- Use the existing approved deployment/service mechanism. Any new credential, security
  permission, ingress change, scope or material risk requires separate authorization.

## Verification and rollback

Verify public availability, readiness, all four staff role sign-ins/workspaces and
existing roster bindings without external messages or payment charges. Verify that
active and deliberately suspended/invited accounts retain their intended states,
and existing records/counts survive. Keep current authentication and MFA protections.
If a gate fails, stop promotion and retain or restore the prior application release
using the reviewed rollback path; do not delete data, migrate accounts, reset credentials
or restore an older database as a shortcut. Record the deployed SHA and verification
results without credentials or customer contents.
