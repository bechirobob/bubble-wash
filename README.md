# Bubble Wash

Bubble Wash is a Next.js operations web app for Accra laundry pickup, pricing, order tracking, staff handoffs, customer follow-up, and billing.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Production environment

Use `.env.production.example` as the deployment template. Do not commit real secrets.

The pilot deployment requires one Node.js 22 application instance and a mounted persistent volume for `BUBBLEWASH_DATABASE_PATH`. Do not run multiple application replicas against the SQLite file. See `docs/PILOT_RUNBOOK.md` for the release gate, smoke test, backups, and rollback.

Required for staff auth hardening:

```bash
npm run hash-password -- "your-strong-password"
```

Pilot operating mode:

- Keep `NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED=false` to accept bank-transfer and approved-invoice preferences only. Card and Mobile Money remain visible as clearly disabled “Coming soon” services.
- Keep `NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED=false` while operations handles customer follow-up manually from the booking record. Automated WhatsApp and email updates remain visible as “Coming soon.”
- Optional public contact links use `NEXT_PUBLIC_BUBBLEWASH_WHATSAPP` and `NEXT_PUBLIC_BUBBLEWASH_CONTACT_EMAIL`. When unset, the links remain hidden without blocking pilot operations.
- Paystack credentials become required only when online payments are enabled. Resend and WhatsApp provider credentials become required only when automated updates are enabled.

## Integration behavior

- `/api/payments/initialize` returns HTTP 503 while online payments are disabled. When enabled, it accepts a saved booking reference, recalculates that booking on the server, creates a Paystack checkout in GHS, and returns the secure authorization URL. It does not trust a browser-supplied amount.
- `/api/payments/verify?reference=...` verifies Paystack payment status and appends a payment event to the order timeline.
- `/api/submit` stores bookings, roster updates, and support cases. Direct free-form fulfillment-stage writes are rejected; operational transitions must use the verified order queue.
- `/api/orders/advance` appends role-scoped workflow events, requires evidence for scheduling/payment/intake/handoffs/delivery, and clearly reminds staff when manual customer follow-up is required.
- `/api/availability` exposes staff-authenticated vendor/driver capacity tables and recent vendor declines.
- Admin assignment uses SQLite-backed capacity rows, fails closed when area/status eligibility does not match, and decrements vendor/rider capacity atomically.
- Vendors can accept or decline assigned jobs from the shared order board; declines are recorded with reason metadata, release vendor capacity, and move the order into review instead of losing context.
- `/api/health` is the liveness endpoint. `/api/ready` validates production configuration and database integrity and returns HTTP 503 when the instance must not receive pilot traffic.
- Payment verification reconciles the provider reference, GHS currency, and amount against the stored checkout, attaches the result to that order, and records each reference/status once.

## Release checks

```bash
npm ci
npm run check
```

The GitHub `Pilot CI` workflow runs the same lint, test, and Webpack production-build gate on pushes and pull requests. Next.js development still uses Turbopack; the release build uses the supported `--webpack` path for deterministic compatibility with the current native SQLite dependency.

Missing staff-authentication, public URL, persistent-storage, or trusted-edge configuration blocks `/api/ready`. Missing provider credentials block readiness only if the matching integration has been explicitly enabled. Manual pilot mode is reported in readiness warnings and does not claim that online payments or automated sends are live.
