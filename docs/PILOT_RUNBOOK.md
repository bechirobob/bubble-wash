# Bubble Wash Cloudflare runbook

## Release gate

1. Merge only after `Pilot CI` passes on the exact head SHA.
2. The BeCore deployment broker checks out that exact public main-branch SHA and reruns all gates with the Cloudflare production configuration.
3. The broker records a D1 time-travel bookmark, applies migrations, deploys the Worker, and smokes the required routes.
4. Treat `/api/ready` as authoritative. A 200 response is required before production traffic is considered healthy.

The deployment broker owns the Cloudflare token. Bubble Wash does not copy or expose that credential.

## One-time VPS migration

`migration/cloudflare-phase.json` is the cutover state machine:

- `idle`: deploy the Worker to `bubble-wash.becoreops.workers.dev`; do not copy data.
- `staging`: take a consistent live SQLite snapshot, import it to D1, and verify per-table row counts and SHA-256 parity while the VPS still serves production.
- `cutover`: stop the VPS service to freeze writes, take the final snapshot, replace D1 from that snapshot, and verify parity. A failed run automatically restarts the VPS.
- `production`: disable the migration endpoint, attach `bubblewash.co` and `www.bubblewash.co` as Worker custom domains, and smoke production.

Migration authorization is a short-lived GitHub OIDC token restricted to the main branch and `.github/workflows/cloudflare-migrate.yml`. Imported tables and columns are allowlisted. Customer rows are never uploaded as an Actions artifact; only non-sensitive counts and digests are retained. Transient plaintext exports are deleted from the runner and VPS after every attempt.

## Smoke test

Verify:

```text
/
/services
/book
/track
/manage
/early-access
/api/health
/api/ready
```

Then verify a real staff login for each configured role, admin MFA, one customer lookup, one no-op-safe availability read, and that cross-role access is denied. Do not create a paid order as a smoke test.

## Rollback

### Before custom-domain cutover

The VPS remains authoritative. Fix or abort the D1 import, restore migration triggers, and rerun `staging`. No DNS rollback is required.

### After cutover

1. Stop new writes by removing the Worker custom-domain routes or deploying a maintenance response.
2. Select the pre-deploy D1 bookmark artifact and use D1 Time Travel to restore the database to that bookmark.
3. Redeploy the last known-good Worker SHA through the broker.
4. Re-run `/api/ready` and the route smoke test before reopening writes.

The final encrypted VPS SQLite backup is retained for the migration rollback window. It is not the ongoing production database after cutover.

## D1 recovery rehearsal

At least monthly in the pilot:

1. Record the current D1 bookmark.
2. Export D1 to a protected temporary SQL file.
3. Import into a new rehearsal database.
4. Run schema, row-count, staff-auth, capacity-trigger, and delivery-proof checks.
5. Delete the temporary plaintext export and rehearsal database after the result is recorded.

## Incident priorities

- If `/api/ready` fails, stop routing new traffic before debugging.
- If capacity or delivery-proof atomicity is in doubt, disable staff writes; do not repair individual rows from the UI.
- Rotate the Worker session secret only for a suspected compromise because rotation signs every staff session out.
- Keep migration mode disabled after production cutover.
- Never log request bodies, credentials, TOTP secrets, customer contacts, exact rider coordinates, or migration rows.
