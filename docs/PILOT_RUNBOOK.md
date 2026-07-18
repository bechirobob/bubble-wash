# Bubble Wash pilot runbook

Target launch: Wednesday, 22 July 2026. This runbook is the go/no-go standard for the controlled commercial-laundry pilot in Accra. The customer and staff interfaces use the approved restrained, role-focused design direction.

## Pilot operating boundary

- Run one application instance on Node.js 22 with one mounted persistent volume. SQLite WAL is suitable for this controlled pilot, but the database file must not sit on an ephemeral filesystem, NFS share, or volume mounted by multiple app hosts.
- Start with one named admin, one vendor operator, one driver, and one support operator. Do not share credentials between people.
- Keep daily order volume controlled until the first full pickup-to-delivery cycle has been reconciled against the database, billing record, and manual customer follow-up log.
- Pilot payments are bank transfer or approved invoice only. Operations records and reconciles payment outside the online checkout until Paystack is enabled.
- Support owns manual customer follow-up using the phone and email stored on each booking. The public tracker remains the customer's self-service status channel.
- Move to PostgreSQL before horizontal application scaling or multi-city operation.

## Required production configuration

Use `.env.production.example` as the inventory. Before launch:

1. Set `BUBBLEWASH_DATABASE_PATH` to the mounted volume, for example `/var/lib/bubblewash/bubblewash.sqlite`.
2. Generate a unique 32+ character session secret and unique password hashes for all four roles. Set `BUBBLEWASH_DISABLE_DEMO_LOGIN=true`.
3. Set `BUBBLEWASH_PUBLIC_URL=https://bubblewash.co`.
4. Set `NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED=false` and `NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED=false` for the manual operational pilot. The future services appear only as disabled “Coming soon” information.
5. `NEXT_PUBLIC_BUBBLEWASH_WHATSAPP` and `NEXT_PUBLIC_BUBBLEWASH_CONTACT_EMAIL` are optional public contact links and may remain unset during the pilot; the corresponding links stay hidden. Only real, approved public contact values may be added later.
6. Leave Paystack, Resend, and WhatsApp credentials unset until the business accounts are approved. Do not enable either feature flag until its provider credentials and end-to-end tests are complete.
7. Enable exactly one trusted IP-header mode appropriate to the deployment edge. Use `BUBBLEWASH_TRUST_EDGE_HEADERS=true` for a controlled Cloudflare/Fly-style edge header, or `BUBBLEWASH_TRUST_PROXY_HEADERS=true` only when the reverse proxy strips public forwarding headers and writes its own.
8. Restrict the database directory and secret environment values to the application service account. Do not place credentials or provider keys in the repository or client-visible variables.

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

`/api/health` is the liveness check. `/api/ready` is the operational release gate and returns HTTP 503 for blocking authentication, URL, persistent-database, trusted-edge, enabled-provider, or integrity failures. It returns HTTP 200 with explicit warnings when the approved manual payment and follow-up pilot mode is active.

## Wednesday smoke test

Use a fresh test customer and a test bank-transfer/invoice record approved by the business owner.

1. Open the homepage on a phone and laptop. Confirm navigation, coverage, visible add-ons, quote, booking, tracking, and staff login retain the approved design. Confirm card, Mobile Money, WhatsApp automation, and email automation are clearly labeled “Coming soon” and cannot be selected.
2. Submit one pickup booking. Record the Bubble Wash reference and confirm only one order appears in admin.
3. Support copies the customer's phone/email from the booking record, confirms the route manually, and records the follow-up in the order workflow. Confirm no automated email or WhatsApp request is attempted.
4. On admin, schedule the pickup and auto-assign the vendor/driver. Double-click once intentionally; the second request must return an already-processed response and must not consume capacity twice.
5. Complete vendor accept, driver pickup, vendor intake/washing/ready, return delivery, support follow-up, and admin closeout using the same Order ID.
6. Record bank-transfer or approved-invoice status using the staff workflow and reconcile it against the business payment record. Confirm `/api/payments/initialize` and `/api/payments/verify` return HTTP 503 while online payments are disabled.
7. Confirm public tracking shows only the customer's first name, area, route window, status, next step, and safe route label. It must not reveal phone, email, payment details, vendor, driver, or location notes.
8. Sign each role out and verify protected pages and APIs return to login or HTTP 401.

## Backup and restore

- Take a provider volume snapshot before every deployment and at least daily during the pilot.
- Run `npm run db:backup -- /separate-mounted-backup-path/bubblewash-YYYY-MM-DD.sqlite` for an application-consistent SQLite backup. The command refuses overwrite and runs `PRAGMA quick_check` on the result.
- Keep at least 30 daily backups, with a copy outside the application volume. Treat backups as sensitive customer data.
- Restore only during a declared maintenance window: stop the app, preserve the failed database and WAL/SHM companions, place a verified backup at `BUBBLEWASH_DATABASE_PATH`, start one instance, check `/api/ready`, and run the order/tracking smoke tests before reopening bookings.

## Monitoring and response

- Alert on `/api/ready` non-200 responses, unexpected readiness warning changes, HTTP 5xx rate, SQLite busy/locked errors, and login 429 spikes.
- Reconcile bank-transfer and invoice status against the business payment record daily. Do not mark an order paid from a customer statement alone.
- The admin owns dispatch and closeout, support owns customer communication, and one named technical operator owns deployment, database backup, and rollback.
- For suspected account compromise: disable the affected role, rotate its password hash and the session secret, restart the service, and review the order event trail.
- For database errors: stop new bookings, keep the site in maintenance mode, preserve the volume, and restore only from a verified backup.

## Rollback

Keep the previous production image/commit and its compatible volume snapshot. If the release gate or smoke test fails, stop traffic to the new instance, redeploy the previous image without changing the database schema manually, verify `/api/health` and staff access, then reopen the controlled pilot. Never run two revisions against the SQLite volume at the same time.
