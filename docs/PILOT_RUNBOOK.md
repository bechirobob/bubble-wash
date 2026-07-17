# Bubble Wash pilot runbook

Target launch: Wednesday, 22 July 2026. This runbook is the go/no-go standard for the controlled Accra pilot. It deliberately keeps the current customer and staff interface unchanged.

## Pilot operating boundary

- Run one application instance on Node.js 22 with one mounted persistent volume. SQLite WAL is suitable for this controlled pilot, but the database file must not sit on an ephemeral filesystem, NFS share, or volume mounted by multiple app hosts.
- Start with one named admin, one vendor operator, one driver, and one support operator. Do not share credentials between people.
- Keep daily order volume controlled until the first full pickup-to-delivery cycle has been reconciled against the database, provider dashboards, and customer notifications.
- Move to PostgreSQL before horizontal application scaling or multi-city operation.

## Required production configuration

Use `.env.production.example` as the inventory. Before launch:

1. Set `BUBBLEWASH_DATABASE_PATH` to the mounted volume, for example `/var/lib/bubblewash/bubblewash.sqlite`.
2. Generate a unique 32+ character session secret and unique password hashes for all four roles. Set `BUBBLEWASH_DISABLE_DEMO_LOGIN=true`.
3. Set `BUBBLEWASH_PUBLIC_URL=https://bubblewash.co`.
4. Configure Paystack with a live Ghana-enabled key. Confirm the merchant account can accept GHS card and mobile-money transactions.
5. Configure Resend and WhatsApp credentials, sender identity, operations destinations, and approved WhatsApp templates or session-message policy.
6. Enable exactly one trusted IP-header mode appropriate to the deployment edge. Use `BUBBLEWASH_TRUST_EDGE_HEADERS=true` for a controlled Cloudflare/Fly-style edge header, or `BUBBLEWASH_TRUST_PROXY_HEADERS=true` only when the reverse proxy strips public forwarding headers and writes its own.
7. Restrict the database directory and environment values to the application service account. Do not place secrets in the repository or client-visible `NEXT_PUBLIC_` variables.

## Release gate

Run from the exact release commit:

```bash
npm ci
npm run check
```

The release is a no-go if lint, tests, or the production build fails. After deployment:

```bash
curl --fail --silent --show-error https://bubblewash.co/api/health
curl --fail --silent --show-error https://bubblewash.co/api/ready
```

`/api/health` is the liveness check. `/api/ready` is the release gate and returns HTTP 503 for blocking authentication, URL, persistent-database, or integrity failures. Warnings identify payment, notification, or proxy-rate-limit configuration that still needs attention.

## Wednesday smoke test

Use a fresh test customer and a low-value live transaction approved by the business owner.

1. Open the homepage on a phone and laptop. Confirm navigation, coverage, quote, booking, tracking, and staff login retain the approved design.
2. Submit one pickup booking. Record the Bubble Wash reference and confirm only one order appears in admin.
3. Confirm customer and operations email/WhatsApp delivery. Provider failures must be visible in server logs and provider dashboards, not exposed to the customer response.
4. On admin, schedule the pickup and auto-assign the vendor/driver. Double-click once intentionally; the second request must return an already-processed response and must not consume capacity twice.
5. Complete vendor accept, driver pickup, vendor intake/washing/ready, return delivery, support follow-up, and admin closeout using the same Order ID.
6. Initialize one Paystack payment, complete it, and verify it. Confirm currency and amount match, the event attaches to the original checkout, and refreshing the callback does not create a duplicate status event.
7. Confirm public tracking shows only the customer's first name, area, route window, status, next step, and safe route label. It must not reveal phone, email, payment details, vendor, driver, or location notes.
8. Sign each role out and verify protected pages and APIs return to login or HTTP 401.

## Backup and restore

- Take a provider volume snapshot before every deployment and at least daily during the pilot.
- Run `npm run db:backup -- /separate-mounted-backup-path/bubblewash-YYYY-MM-DD.sqlite` for an application-consistent SQLite backup. The command refuses overwrite and runs `PRAGMA quick_check` on the result.
- Keep at least 30 daily backups, with a copy outside the application volume. Treat backups as sensitive customer data.
- Restore only during a declared maintenance window: stop the app, preserve the failed database and WAL/SHM companions, place a verified backup at `BUBBLEWASH_DATABASE_PATH`, start one instance, check `/api/ready`, and run the order/tracking smoke tests before reopening bookings.

## Monitoring and response

- Alert on `/api/ready` non-200 responses, HTTP 5xx rate, SQLite busy/locked errors, login 429 spikes, notification failures, and Paystack verification mismatches.
- Reconcile Bubble Wash payment events against the Paystack dashboard daily. A successful provider transaction is not fulfilled unless reference, GHS currency, and amount all match the stored checkout.
- The admin owns dispatch and closeout, support owns customer communication, and one named technical operator owns deployment, database backup, and rollback.
- For suspected account compromise: disable the affected role, rotate its password hash and the session secret, restart the service, and review the order event trail.
- For database errors: stop new bookings, keep the site in maintenance mode, preserve the volume, and restore only from a verified backup.

## Rollback

Keep the previous production image/commit and its compatible volume snapshot. If the release gate or smoke test fails, stop traffic to the new instance, redeploy the previous image without changing the database schema manually, verify `/api/health` and staff access, then reopen the controlled pilot. Never run two revisions against the SQLite volume at the same time.
