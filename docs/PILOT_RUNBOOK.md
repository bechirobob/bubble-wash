# Bubble Wash pilot runbook

This runbook is the go/no-go standard for the controlled commercial-laundry pilot in Accra and the native household early-access channel on `bubblewash.co`.

## Pilot operating boundary

- Run one application instance on Node.js 22 with one mounted persistent volume. SQLite WAL is suitable for this controlled pilot, but the database file must not sit on an ephemeral filesystem, NFS share, or volume mounted by multiple app hosts.
- Start with one named admin, one vendor operator, one driver, and one support operator. Do not share credentials between people.
- Keep daily order volume controlled until the first full pickup-to-delivery cycle has been reconciled against the database, billing record, and manual customer follow-up log.
- Pilot payments are bank transfer or approved invoice only. Operations records and reconciles payment outside the online checkout until Paystack is enabled.
- Support owns manual customer follow-up using the phone and email stored on each booking. The public tracker remains the customer's self-service status channel.
- Run the notification/retention worker every 10 minutes and the encrypted backup/restore-proof job nightly. Readiness blocks when the latest proof is older than 30 hours.
- Move to PostgreSQL before horizontal application scaling or multi-city operation. Use `docs/SCALING_PLAN.md`; never point multiple replicas at SQLite.

## Required production configuration

Use `.env.production.example` as the inventory. Before launch:

1. Set `BUBBLEWASH_DATABASE_DRIVER=sqlite` and `BUBBLEWASH_DATABASE_PATH` to the mounted volume, for example `/var/lib/bubblewash/bubblewash.sqlite`.
2. Generate a unique 32+ character session secret and a different strong password hash for each of the four current role logins. Set `BUBBLEWASH_DISABLE_DEMO_LOGIN=true`. The current master-admin operating mode uses `BUBBLEWASH_ADMIN_MFA_REQUIRED=false` and `NEXT_PUBLIC_BUBBLEWASH_ADMIN_MFA_REQUIRED=false`, so the approved admin email and password open the workspace without an authenticator code. If the owner later enables MFA, set both flags true, complete `/admin/mfa/enroll`, save the eight one-use recovery codes, and test code and recovery-code replay protection before reopening admin access.
3. Set `BUBBLEWASH_PUBLIC_URL=https://bubblewash.co`.
4. Set `BUBBLEWASH_VENDOR_ENTITY_ID` and `BUBBLEWASH_DRIVER_ENTITY_ID` to the exact approved roster IDs. The current pilot has one configured rider login; only that bound rider may share foreground GPS.
5. Set `NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED=false` and `NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED=false` for the manual operational pilot. The future services appear only as disabled “Coming soon” information.
6. `NEXT_PUBLIC_BUBBLEWASH_WHATSAPP` and `NEXT_PUBLIC_BUBBLEWASH_CONTACT_EMAIL` are optional public contact links and may remain unset during the pilot; the corresponding links stay hidden. Only real, approved public contact values may be added later.
7. Leave Paystack unset while online payments remain disabled. Configure Resend plus approved `WHATSAPP_EARLY_ACCESS_TEMPLATE` and `WHATSAPP_PRIVACY_TEMPLATE` credentials before launch; these confirmations are operational even while commercial automated updates remain disabled. Do not enable commercial automated updates until booking/operations templates and end-to-end tests pass.
8. Enable exactly one trusted IP-header mode appropriate to the deployment edge. Use `BUBBLEWASH_TRUST_EDGE_HEADERS=true` for a controlled Cloudflare/Fly-style edge header, or `BUBBLEWASH_TRUST_PROXY_HEADERS=true` only when the reverse proxy strips public forwarding headers and writes its own.
9. Set the exact `BUBBLEWASH_LEGAL_ENTITY_NAME` and confirmed `BUBBLEWASH_DPC_REGISTRATION_NUMBER`. The business owner must approve the service terms, privacy notice, retention schedule, and refund policy; placeholders are a release blocker.
10. Set a random maintenance token, a base64 32-byte backup key, the VPS primary/staging directories, and a backup status path. Keep `Nightly Production Backup` enabled in GitHub Actions; it performs the off-host transfer through Tailscale. Restrict database, backup, and secret paths to the application service account. To recover an unknown master-admin credential, issue a reviewed 256-bit, one-use recovery token with a short expiry. Commit or configure only its SHA-256 hash, deliver the fragment-based `/admin/recover#…` URL privately, and remove the recovery configuration in the next release after successful use. Never put the chosen username, password, or raw token in GitHub Actions, source control, logs, or support tickets.

## Release gate

Run from the exact release commit:

```bash
npm ci
npm run check
```

The release is a no-go if lint, tests, dependency audits, route verification, or the production build fails. Run `npm audit --audit-level=moderate` and `npm audit --omit=dev --audit-level=moderate` again from the exact candidate lockfile; any newly published moderate-or-higher vulnerability blocks deployment. Before traffic moves, require the production deployment workflow to create, restore-test, and upload its encrypted backup before activation. After deployment:

```bash
curl --fail --silent --show-error https://bubblewash.co/api/health
curl --fail --silent --show-error https://bubblewash.co/api/ready
```

`/api/health` is the liveness check. `/api/ready` is the operational release gate and returns HTTP 503 for blocking authentication, URL, persistent-database, trusted-edge, enabled-provider, or integrity failures. It returns HTTP 200 with explicit warnings when the approved manual payment and follow-up pilot mode is active.

## Wednesday smoke test

Use a fresh test customer and a test bank-transfer/invoice record approved by the business owner.

1. Open the landing page, Services, Book, Track, Manage order, Household, and staff login on a phone and laptop. Confirm the shared navigation, iconography, route transitions, pricing calculator, booking, and tracking retain the approved design. Confirm card, Mobile Money, WhatsApp automation, and email automation remain unavailable while their feature flags are off.
2. Submit one pickup booking. Record the Bubble Wash reference and private six-digit delivery code; confirm only one order appears in admin. Verify `/manage` opens only with the reference plus matching booking contact and creates requests without changing the order stage.
3. Support uses the booking phone/email, then records the channel, outcome, operator note, and next follow-up time on that order. Confirm no automated email or WhatsApp request is attempted.
4. On admin, enter a confirmed pickup window, then assign the vendor/driver. The assignment must stop if current capacity does not match the order area, if the vendor is tomorrow-only, or if the rider is training/paused. Double-click once intentionally; the second request must return an already-processed response and must not consume capacity twice.
5. Open and print the signed bag QR. Scan it while signed in as each relevant role and confirm it routes to the same order. Complete vendor accept, driver pickup with bag-count/handoff proof, vendor handoff, vendor intake with tag/count/condition, washing, ready quality check, and return delivery. An incorrect delivery code must fail; the correct code must save recipient/count proof once and reject replay.
6. On the rider's HTTPS mobile route page, confirm location permission is requested only after selecting **Start live sharing**. Admin must see the matching live/recent marker and freshness within about 15 seconds. Vendor, Support, public tracking, and unauthenticated requests must not receive coordinates. Select **Stop sharing** and confirm the marker clears; completing or reassigning the order must also invalidate it.
7. Record bank-transfer or approved-invoice evidence using its amount, reference, date, and reconciliation note. Closeout must remain unavailable until that evidence is saved. Confirm `/api/payments/initialize` and `/api/payments/verify` return HTTP 503 while online payments are disabled.
8. Confirm public tracking shows only the customer's first name, area, route window, status, next step, and safe route label. It must not reveal phone, email, payment details, vendor, driver, or location notes.
9. Submit household early access and a privacy request. Confirm native URLs remain on `bubblewash.co`, one confirmation per channel is deduplicated, the admin operations queue can change privacy status, and the maintenance worker retries failed sends.
10. Check `/privacy`, `/terms`, `/refund-policy`, `/robots.txt`, and `/sitemap.xml`; validate canonical URLs and the production legal identity/registration. Sign each role out and verify protected pages and APIs return to login or HTTP 401.

## Staff operating flow

- Admin owns the confirmed collection window, eligibility-checked vendor/rider assignment, payment reconciliation, exception escalation, and final closeout.
- Vendors work only from the assigned order row: accept/decline, confirm tagged intake, start washing, record the ready count and quality check. Direct free-form stage writes are blocked.
- Drivers work only from the route row: start, confirm collected count, record the vendor recipient/count, report a delay, and capture final recipient/count proof. A delay opens an urgent support case without rewinding the fulfillment stage.
- Support can see normal bookings as well as at-risk orders, log manual customer contact, and work one grouped history per case. Support/payment activity must not overwrite the fulfillment stage, SLA start, or customer contact details.
- Keep the exact customer street address staff-only. Public tracking continues to expose only the safe route label and approved customer fields.

## Backup and restore

- Take a provider volume snapshot before every deployment. The backup job creates a consistent SQLite snapshot, encrypts it with AES-256-GCM, writes non-overwriting primary and transfer-staging copies, decrypts the staging copy into a temporary restore proof, and runs `PRAGMA quick_check`. It does not mark readiness healthy until GitHub confirms the encrypted artifact was stored off-host.
- `Nightly Production Backup` runs at 01:15 UTC (02:15 Malabo and 01:15 Accra). GitHub retains encrypted artifacts for 35 days. The VPS retains primary copies for seven days by default and removes each staging copy after a successful transfer; failed staging copies are pruned after two days. Treat the key, status path, and encrypted copies as sensitive. Monitor workflow failure; `/api/ready` becomes blocked after 30 hours without a current restore and off-host storage proof.
- Restore only during a declared maintenance window: stop the app, preserve the failed database and WAL/SHM companions, decrypt a selected off-site backup with a separately reviewed recovery procedure, verify it away from production, place it at `BUBBLEWASH_DATABASE_PATH`, start exactly one instance, and run readiness/order/customer-access smoke tests before reopening bookings.

## Monitoring and response

- Alert on `/api/ready` non-200 responses, failed or stale nightly backup workflows, protected `/api/internal/metrics` database failure, outbox failed/pending growth, open privacy cases, HTTP 5xx rate, SQLite busy/locked errors, and login 429 spikes. Never put the maintenance token in a browser or public monitoring URL.
- Retention maintenance removes expired limiter/MFA state, 90-day notification logs, opted-out early-access records after 30 days, active early-access records 12 months after the configured household launch date, completed privacy-case evidence after 36 months, and closed order groups after 24 months. Pause purging under a documented dispute or legal hold.
- Reconcile bank-transfer and invoice status against the business payment record daily. Do not mark an order paid from a customer statement alone.
- The admin owns dispatch and closeout, support owns customer communication, and one named technical operator owns deployment, database backup, and rollback.
- For suspected account compromise: disable the affected role, rotate its password hash and the session secret, restart the service, and review the order event trail.
- For database errors: stop new bookings, keep the site in maintenance mode, preserve the volume, and restore only from a verified backup.

## Rollback

Keep the previous production image/commit and its compatible volume snapshot. If the release gate or smoke test fails, stop traffic to the new instance, redeploy the previous image without changing the database schema manually, verify `/api/health` and staff access, then reopen the controlled pilot. Never run two revisions against the SQLite volume at the same time.
