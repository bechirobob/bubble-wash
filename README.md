# Bubble Wash

Bubble Wash is a Next.js operations web app for Accra laundry pickup, pricing, order tracking, staff handoffs, notifications, and payment checkout.

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

Payment and notification integrations:

- Paystack checkout: `PAYSTACK_SECRET_KEY`, `BUBBLEWASH_PUBLIC_URL`
- Optional review-stage customer contact links: `NEXT_PUBLIC_BUBBLEWASH_WHATSAPP`, `NEXT_PUBLIC_BUBBLEWASH_CONTACT_EMAIL`. When unset, the public links are hidden and `/api/ready` reports warnings rather than blocking the review deployment.
- Email alerts: `RESEND_API_KEY`, `BUBBLEWASH_EMAIL_FROM`, `BUBBLEWASH_OPERATIONS_EMAIL`
- WhatsApp alerts: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_API_VERSION`, `BUBBLEWASH_OPERATIONS_WHATSAPP`

## Integration behavior

- `/api/payments/initialize` accepts a saved booking reference, recalculates that booking on the server, creates a Paystack checkout in GHS, and returns the secure authorization URL. It does not trust a browser-supplied amount.
- `/api/payments/verify?reference=...` verifies Paystack payment status and appends a payment event to the order timeline.
- `/api/submit` stores bookings/onboarding/support events and attempts email/WhatsApp notifications when provider credentials are configured.
- `/api/orders/advance` appends role-scoped workflow events and attempts timeline notifications.
- `/api/availability` exposes staff-authenticated vendor/driver capacity tables and recent vendor declines.
- Admin auto-assignment uses SQLite-backed vendor capacity rows and admin-only driver availability rows, decrementing capacity as orders are assigned.
- Vendors can accept or decline assigned jobs from the shared order board; declines are recorded with reason metadata, release vendor capacity, and move the order into review instead of losing context.
- `/api/health` is the liveness endpoint. `/api/ready` validates production configuration and database integrity and returns HTTP 503 when the instance must not receive pilot traffic.
- Payment verification reconciles the provider reference, GHS currency, and amount against the stored checkout, attaches the result to that order, and records each reference/status once.

## Release checks

```bash
npm ci
npm run check
```

The GitHub `Pilot CI` workflow runs the same lint, test, and Webpack production-build gate on pushes and pull requests. Next.js development still uses Turbopack; the release build uses the supported `--webpack` path for deterministic compatibility with the current native SQLite dependency.

Missing provider credentials are reported safely in JSON responses; the app does not fake live sends.
