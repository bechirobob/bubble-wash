# Bubble Wash

Bubble Wash is a Next.js operations web app for Accra laundry pickup, pricing, order tracking, signed bag handoffs, customer self-service, household early access, data-rights handling, and billing.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Production environment

Use `.env.production.example` as the deployment template. Do not commit real secrets.

The pilot deployment requires one Node.js application instance, a mounted persistent volume for `BUBBLEWASH_DATABASE_PATH`, a separate off-site backup mount, and scheduled maintenance/backup timers. Do not run multiple application replicas against the SQLite file. See `docs/PILOT_RUNBOOK.md` for the release gate, smoke test, backups, and rollback; see `docs/SCALING_PLAN.md` before adding replicas.

Required for staff auth hardening:

```bash
npm run hash-password -- "your-strong-password"
npm run mfa:setup -- admin@example.com
```

Pilot operating mode:

- Keep `NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED=false` to accept bank-transfer and approved-invoice preferences only. Card and Mobile Money remain visible as clearly disabled “Coming soon” services.
- Keep `NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED=false` while operations handles commercial-order follow-up manually. Native household early-access and privacy-request confirmations still require Resend and approved WhatsApp templates and use the durable retry outbox.
- Optional public contact links use `NEXT_PUBLIC_BUBBLEWASH_WHATSAPP` and `NEXT_PUBLIC_BUBBLEWASH_CONTACT_EMAIL`. When unset, the links remain hidden without blocking pilot operations.
- Paystack credentials become required only when online payments are enabled. Early-access and privacy confirmation provider credentials are always required in production; commercial booking/operations templates are required only when automated commercial updates are enabled.

## Integration behavior

- `/` is the product landing page and owns the commercial overview plus How it works. `/services` owns plans, coverage, service conditions, and estimates; `/book` owns the booking transaction; `/track` owns public status lookup. Public, customer, policy, and staff entry surfaces share one navigation and system-icon language.
- `/book` recommends a collection plan from a short operational-fit survey, collects the exact pickup point and a two-hour window, and never asks the customer to estimate bag weight or select a broad area.
- `/api/submit` derives a normalized pickup locality, concentration-cluster key, and route zone from the exact address on the server. Unmatched locations enter the operations mapping queue instead of accepting a browser-supplied area.
- `/api/payments/initialize` returns HTTP 503 while online payments are disabled. When enabled, it accepts a saved booking reference, recalculates the selected plan service fee on the server, creates a Paystack checkout in GHS, and returns the secure authorization URL. It does not trust a browser-supplied amount; processing remains based on verified intake.
- `/api/payments/verify?reference=...` verifies Paystack payment status and appends a payment event to the order timeline.
- `/api/submit` stores bookings, roster updates, and support cases. Direct free-form fulfillment-stage writes are rejected; operational transitions must use the verified order queue.
- `/api/orders/advance` appends role-scoped workflow events, requires evidence for scheduling/payment/intake/handoffs/delivery, and clearly reminds staff when manual customer follow-up is required.
- `/api/orders/label` creates a signed, printable bag QR for an authorised admin/vendor/rider. Final delivery consumes the customer's one-use six-digit handoff code in the same database transaction as the delivery event.
- `/manage` verifies a booking reference plus booking email/phone, opens a 30-minute HttpOnly customer session, and queues reschedule, cancellation, or care requests without silently mutating fulfillment.
- `/early-access` is the native household signup flow; `/privacy`, `/terms`, and `/refund-policy` are canonical policy pages, and `/api/privacy/requests` records data-rights cases for the admin operations queue.
- `/api/internal/maintenance` retries the notification outbox and enforces retention behind a bearer secret. `/api/internal/metrics` exposes privacy/outbox/order counts to protected monitoring only.
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

Missing staff authentication/MFA, legal controller registration, customer-confirmation providers, public URL, persistent storage, fresh restore-verified encrypted backup, maintenance secret, or trusted-edge configuration blocks `/api/ready`. Manual commercial payment/follow-up mode remains explicit and does not claim that online checkout or commercial automated sends are live.
