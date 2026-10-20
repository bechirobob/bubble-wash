# Fresh-start reset: prepared, not executed

This separate procedure is for the explicitly confirmed permanent deletion of all current operational data without a new backup. It is **not** a deployment authorization or a replacement for the existing backup-gated production reset scripts. Historical backup archives are outside its scope and remain untouched.

## Scope

Delete orders/customer submissions (including operational audit submissions), payments/billing/invoices and payment-initialization locks, customer recovery tokens, notification outbox/messages, delivery proofs and locations, workflow claims, privacy/early-access customer records, vendor/driver rosters and reservations, and **all nonadmin managed staff accounts**.

Preserve all managed admin rows, effective owner/admin credentials, credential overrides, MFA enrollment/recovery/replay state, admin recovery tokens, prior reset metadata, environment/service settings and infrastructure credentials. No backup archive, environment file, service configuration or credential is changed by the script. Unknown tables, views and triggers stop the operation for review. Absent required authentication tables also stop it.

## Deployment/account-model prerequisite

The matching application release must be deployed and validated under separate authorization before the reset. Production vendor/driver/support authentication now requires an active managed account, with vendor/driver roster bindings; legacy environment worker logins and built-in demo identities are not production identities. Removing a managed account therefore cannot revive a legacy login or keep its existing session usable. If workers must remain active before reset, migrate/verify their individual managed accounts before this release.

Production readiness checks effective owner/admin access and all existing infrastructure checks, but does not require a worker roster. Empty workers after reset are valid. This does not waive the backup-readiness check; an unrelated broken backup still blocks `/api/ready`.

## Preconditions and controlled operation

1. Verify the release source and actual service layout on the host. This script recognizes the existing user `bubblewash-local.service` and system `bubblewash-maintenance.service`/`.timer`. A different layout is a blocker, not a reason to skip checks.
2. Verify owner/admin password sign-in and any enabled MFA before the maintenance window. Preserve session/MFA keys and owner/admin credentials. Any required legacy-worker environment cleanup or other security configuration change must be separately authorized; the script never performs it. Do not create a backup for this specifically confirmed no-new-backup reset.
3. Hold the existing deployment lock (`/home/ubuntu/bubblewash-runtime/deploy.lock`) for the entire stop/reset/restart/verification window. Use the same application user context and user-systemd bus as the existing deployment procedure. Freeze other deployments and direct database writers. Stop the maintenance timer, wait for its service to stop, and stop the user application service. Confirm no separate application process or direct database job remains. Do not merely edit an environment file while an old process is running.
4. Run from the real current application directory, with the same production environment as the service, including `NODE_ENV=production`, explicit absolute SQLite path and disabled demo login. The script verifies stopped unit states, zero main PIDs, matching resolved working directories, and matching authentication/database configuration from systemd and its environment file. Missing systemd access or unsupported environment quoting fails closed and requires review, never an assertion flag.
5. With all writers stopped and the deployment lock retained, run `node --experimental-strip-types scripts/reset-fresh-start.mjs` for the read-only inventory. Review counts and its SHA-256 fingerprint against the exact approved scope. This opens the existing database read-only; it never imports legacy JSONL or initializes app tables. A pending `data/submissions.jsonl` blocks the operation because application startup would import it. Do not silently delete or archive that file.
6. Only for the exact approved reset, pass the reviewed fingerprint as `BUBBLEWASH_FRESH_RESET_FINGERPRINT`, the exact confirmation `BUBBLEWASH_CONFIRM_FRESH_RESET=DELETE_ALL_NONADMIN_OPERATIONAL_DATA_WITHOUT_NEW_BACKUP`, and run `node --experimental-strip-types scripts/reset-fresh-start.mjs --apply`. The immediate transaction rechecks data/schema/configuration fingerprints, deletes only the declared records, verifies byte-preserved admin/security rows and unchanged effective admin identities, checks database integrity and repeats stopped-runtime checks before commit. Any failure rolls back. Do not retry a changed inventory without reviewing it again.
7. Start only the application service first, with maintenance still stopped and public access restricted by the approved maintenance procedure. Verify the same owner/admin can sign in, required MFA works, old worker sessions/passwords fail, lists/rosters are empty and do not reseed, and health/readiness checks pass. Use read-only UI checks; do not create real orders, payments or send messages. If checks fail, leave maintenance stopped, investigate and report the actual blocker. Do not declare completion or automatically restore old customer data.
8. Restart the maintenance timer only after the verified application/authentication checks succeed. Verify its state and release the deployment lock. Report the final counts and authentication/readiness outcome without disclosing credentials or personal records.

`ownerAccessConfigured` in inventory means the effective resolver found a structurally valid, non-demo admin hash and usable required MFA under the supplied configuration. It does **not** prove password possession, live login, service restart, or production success. Those checks remain mandatory above. The script does not acquire the deployment lock or control services itself.

## Synthetic verification

- `node --conditions=react-server --test tests/fresh-start-reset.test.mjs`
- `node --conditions=react-server --experimental-strip-types --experimental-loader=./tests/alias-loader.mjs tests/fresh-start-auth.integration.mjs`

The integration uses only isolated generated SQLite data, valid synthetic password hashes, real encrypted synthetic MFA enrollment and one-use recovery codes. No production reset, external message or financial transaction is part of these tests.
