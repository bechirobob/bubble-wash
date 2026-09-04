# Audit remediation — 4 September 2026

This release addresses the sixteen numbered findings from the visual and functional audit. The production staff-access lock remains intentional. New bookings pause while that lock is enabled; tracking, existing-order management, and early access remain available.

## Changes

| Audit finding | Implemented behavior |
| --- | --- |
| BW-01 Backups | Nightly export consumes the filename from the restore-verified backup result, removing the broken remote `find` escaping. Off-host upload must succeed before readiness is refreshed. |
| BW-02 Booking availability | Server and booking page share the same operational gate. Collection windows are requests until staff confirms them. |
| BW-03 History retrieval | Public tracking loads an indexed complete order history. Staff queues page order roots before loading histories, with server search and older-order controls. |
| BW-04 Session revocation | Every staff role checks the current credential version. Individual account reset/suspension revokes existing sessions. |
| BW-05 Handoff recovery | A customer can replace an unused code. The previous code is invalidated atomically, with an audit event and per-order limits. Existing reference/contact access alone cannot replace a code: the original booking session or email recovery is required. |
| BW-06 Booking validation | Real calendar dates, a thirty-day horizon, unstarted two-hour windows, typed public fields, and a strict add-on allowlist are enforced server-side. |
| BW-07 Duplicate booking | Browser retries reuse a request key. Booking, initial handoff proof, and notification queue entries commit together. Changed payloads cannot reuse an existing key. |
| BW-08 Billing | Frozen booking prices produce integer-money, itemized invoices from verified intake. Payments, credits, refunds and outstanding balances use a durable ledger. One account-period service fee is charged once. Approved receivables remain distinct from paid invoices. Legacy/custom orders have an administrator invoice-evidence form. |
| BW-09 Price explanation | Quotes show the minimum adjustment and total per collection. Booking explains the monthly fee, included collection count, processing rate, minimum, extras and route fees. |
| BW-10 Fractional weight | Rate bands are continuous up to the next band boundary. Whole-load volume pricing and collection minimums are disclosed. |
| BW-11 Customer management | Network failures recover, pending controls reset, form references survive asynchronous work, sessions restore, confirmed schedules and customer-specific next steps appear. |
| BW-12 Payments | Raw-body HMAC verification, provider reconciliation, idempotent settlement, invoice ownership/balance checks, checkout reuse and initialization locks supplement the browser callback. Maintenance reconciles recent unsettled attempts. |
| BW-13 Updates | Core order transitions enqueue deduplicated customer updates. Calling preferences no longer opt into WhatsApp. Tracking links point to the actual route. Missing confirmations are not labeled sent/queued. A production maintenance timer retries delivery. |
| BW-14 Staff identity | Administrators create/reset individual support, vendor and rider accounts using expiring single-use activation links. Vendor/rider identities require an existing roster binding. Master-admin recovery remains separate. |
| BW-15 Care and assignment | Premium care and separate ironing are mutually exclusive. Express orders must also match the required cleaning capability. |
| BW-16 Customer decisions | Approving a cancellation or reschedule changes the order, with duplicate-decision protection. Cancellation releases reserved capacity. Quality, damage and refund cases hold records for review; refunds require a recorded financial reconciliation. |

## Visual changes

- Plain customer language replaces technical marketing and workflow descriptions.
- Booking carries the calculator's validated plan and extras, shows the selected plan's actual terms, and uses a shorter introduction.
- Inputs use at least 16 px text, stronger boundaries and solid keyboard focus indicators. Small operational map labels are enlarged.
- Staff login keeps its fields and locked response, while removing repeated role descriptions and internal destination paths.
- Customer pages expose clear invoice balances, recovery actions and meaningful next steps.
- New access, invoice and request-decision controls live in a separate component module. Core booking, billing, recovery and account rules live in focused server modules.

## Operational setup that cannot be invented

- Staff login remains disabled by the deployment configuration, as requested. This also pauses new bookings. Remove the lock only when operations are ready to accept work.
- Paystack remains disabled until the owner configures real provider credentials and registers `https://bubblewash.co/api/payments/webhook`. No live payments are created by the tests.
- Email/WhatsApp delivery needs genuine provider credentials and approved templates. Email recovery clearly reports unavailable when email delivery is not configured. No customer messages are sent during validation.
- Verified legal operator/contact/registration details must come from the owner; this release does not invent them.
- Recurring contracts are still scheduled collections, not automatic recurring card charges. Included collection counts are stated per calendar month. Holiday calendars, automatic recurrence generation and verified geocoding are future product work requiring explicit contract and location data.
- Native iPhone/Android browser and keyboard behavior needs device sign-off. Automated HTTP tests and desktop production inspection do not constitute native-device certification.

## Billing rules

Pricing is frozen at booking. Each invoice uses actual verified kilograms, line-rounded extras, the route charge, the GHS 450 collection minimum, and the monthly service fee if this account/period has not already incurred it. Account-period grouping uses the normalized billing email and business name; a formal account identity is the next step before multi-user enterprise consolidation. Current catalog fees and rates are unchanged.

The invoice ledger stores payments, approved credits and completed refunds separately. Manual entries cannot exceed the outstanding balance or cash received. Verified provider overpayments remain recorded as customer credit instead of disappearing. Recording a refund documents an already-completed bank/provider operation; it does not initiate a refund remotely.

## Verification gates

- Existing unit/integration tests plus audit regressions for old-order visibility, valid dates, duplicate submissions, proof replacement, session revocation, ledger arithmetic, capability matching and capacity release.
- A production HTTP workflow test signs in as four synthetic roles, books, schedules, assigns, collects, verifies intake, washes, returns, pays and closes an order, then confirms one-time handoff and restored capacity.
- TypeScript, ESLint, dependency audits, optimized build, required-route and native-image checks.
- GitHub CI must pass before the existing production workflow builds a candidate, creates/restores/exports its encrypted backup and performs preflight and public smoke checks.

The regression tests use temporary databases and disabled provider credentials. New database tables are additive; no production history is rewritten or reset.

## Provider and dependency references

- Paystack webhook signature and retry behavior: https://paystack.com/docs/payments/webhooks/
- Browserslist advisory patched in 4.28.7 and later: https://github.com/advisories/GHSA-c83g-rgw3-j3cx
- Related custom-statistics advisory: https://github.com/advisories/GHSA-73wf-gq98-2v4g

The release locks Browserslist 4.28.9 and retains the existing application framework versions.

## Local validation results

The release passed 66 unit tests, 265 existing integration checks, 65 audit-regression checks, and 24 production HTTP workflow checks (420 checks in total). Both dependency audits reported zero vulnerabilities. The optimized build, TypeScript, ESLint, required-route checks and native image runtime passed. Build concurrency is limited to one worker after parallel static export intermittently failed while removing its temporary directory.
