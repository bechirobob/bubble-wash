# Staff website worklists

This local feature adds `/staff/worklist` and cookie-authenticated `/api/staff/automation/[action]` handlers. It does not enable an installable app or restore native authentication.

## Included

- Role-scoped exception and follow-up views, with needs-action/all/overdue filters; admin and support also have mine/unassigned/follow-ups filters. Pagination explicitly covers source-record pages, including sparse pages.
- Admin owner selection and support self-claim/self-update, explicit timezone deadlines, notes, stale-revision checks, idempotency receipts, and audit attribution to the actual signed-in operator. Ownership does not advance orders or contact customers.
- Admin dispatch suggestions reuse approved assignment eligibility and capacity freshness. The existing order action still performs any assignment. Driver-delay exceptions are not presented as assignable.
- Stale capacity reminders for admin and the bound vendor. The existing vendor capacity confirmation remains unchanged.
- Admin-only sanitized message-review metadata and aggregate counts. Provider acceptance is distinguished from delivery. No resend, provider activation, recipient data, message payload or raw provider error is exposed.
- Admin-only paginated payment/invoice/refund-case discrepancies with links to existing order evidence. No payment, refund, credit, payout or automatic financial correction runs here.
- Exact-case reads let worklist links open older cases outside the recent activity window and support case references distinct from their root record ID. The existing support/admin projection is retained, and ambiguous reference aliases reject. Canonical-root selection does not repair older action records associated only through a duplicated alias; legacy histories can still share those records.
- Unsaved ownership drafts survive refresh and browser Back/Forward in actor-scoped tab memory. Removed/nonmatching dirty rows remain visible but read-only. Explicit discard clears drafts; earlier asynchronous responses cannot clear a newer draft. No credentials, drafts or tokens are persisted in local/session storage.

## Boundaries

Authentication, personal-owner MFA/capability, account lifecycle, object authorization, customer-mail settings and payment settings are unchanged. Vendor/driver projections omit staff ownership notes and emails. Support cannot assign someone else or change another operator's ownership. Support-wide vendor capacity access is not added. Notifications are supervised, not sent. Suggestions do not reserve capacity. Native routes remain absent.

No account, provider, real data, live service, repository publication or release configuration is changed by this local feature package. It is separate from the frozen owner-aware website release pair. Adding it to a release requires new exact source/runtime manifests and release verification; earlier frozen-tree release approval does not cover this changed tree.

## Verification commands

Use Node 22, the existing locked dependencies, and a clean checkout without live `.env` files. The HTTP suite creates its own synthetic SQLite database, starts the built application on loopback port 3197 and forbids provider fetches. The graphical fixture blocks external egress and uses loopback ports 3195/3196.

```sh
npm ci
NODE_OPTIONS=--max-old-space-size=384 npm run build
node --conditions=react-server --test --test-concurrency=1 --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tests/*.test.mjs
npm run lint
npm run typecheck
node --conditions=react-server --experimental-strip-types --experimental-loader=./tests/alias-loader.mjs tests/staff-worklists-http.integration.mjs
node --conditions=react-server --experimental-strip-types --experimental-loader=./tests/alias-loader.mjs tests/personal-owner-http.integration.mjs
npm run test:worklist-fixture
npm run test:browser-worklists
```

The worklist browser config uses the Playwright-managed Chromium by default; set `BUBBLEWASH_TEST_CHROMIUM_PATH` only to a trusted existing Chromium executable if needed. It covers desktop 1440px and mobile 390px layouts, actual cookie login, lost successful responses, duplicate-safe retry, stale conflict recovery, scoped roles, refresh errors, Back/Forward draft races, overflow and neutral-shadow checks. It writes screenshots for visual inspection.

Graphical execution and visual acceptance remain an explicit unverified gate in the current executor: Chromium was blocked before launch by the environment's socket restriction. Do not interpret that infrastructure failure as a passing UI test. Run this suite in an approved browser-capable environment, inspect its screenshots, and resolve any real failures before release.

## CI and release integration

The existing Browser workflow regression job installs locked dependencies, builds once, and runs the ordinary staff journeys and the worklist suite in separate steps. Worklist checks still run after an ordinary journey failure when the build succeeded. The worklist fixture smoke check verifies the exact graphical fixture and four cookie-authenticated roles without claiming graphical execution. Screenshots are taken explicitly only in synthetic staff workspaces; automatic failure screenshots, video and traces are disabled. The separate screenshot artifact must exist after a successful build, and no authentication credentials are intentionally captured.

This feature is rebased onto the portable-v4 integration candidate rather than restoring earlier complete source archives. Candidate-only exact source/enrollment and cross-version pins identify a new local contract; historical and fallback identities are preserved. Passing local selectors is not release approval or publication. Independent contract review, exact-commit CI and graphical screenshot inspection remain required before separately authorized release preparation.
