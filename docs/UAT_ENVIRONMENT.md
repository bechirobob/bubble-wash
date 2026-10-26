# Isolated seven-day UAT — environment admission

Status: implementation preparation only. No UAT service, tester identity, access grant,
invitation, provider connection or deployment has been created. The existing VPS
production service and its booking pause remain unchanged. `staff.bubblewash.co`
is the production staff application, not the test-environment URL.
`staging.bubblewash.co` has not been verified as isolated or approved for this exercise.

## Coordinator decisions before launch

Record the approved host, exact candidate revision, tester identities/role matrix,
actual credential-issuance UTC timestamp and end (exactly 168 hours later; display both in Malabo time, UTC+1), test-data restorer, and evidence destination.
Use a separate process/container and dedicated database/storage, with no production
volume mounts, backups, credentials, owner identities or customer records. Create a
new empty test database with synthetic fixtures; never reset or clone live data as a shortcut.
Verify the isolated root is not a symlink/mount/bind mount to production storage.
The application checks paths and symlinks but cannot prove storage/mount isolation.

Use `.env.uat.example` only for the isolated instance. The isolation confirmation is
an operator attestation, not proof by itself. Public URL must be a non-production HTTPS
origin (loopback HTTP is accepted for local checks). The UAT data root must already
exist, and the database must be inside it. Use a new random UAT-only session secret of
at least 32 characters. Verify exactly one trusted-client-IP mode for the actual proxy;
never copy production secrets. Build a separate UAT image/config: public feature flags
are embedded at build time. Require a visible **UAT — synthetic data only** environment
label before handing the host to testers. The candidate implements a global UAT banner; this preparation does not claim it is deployed or browser-accepted.

## Provider and financial boundary

Online payments, commercial automated updates and research email are explicitly off.
No Paystack, Resend, WhatsApp, research-email or owner-email provider credentials may be
present. Public real contact links must be empty. Server-side UAT guards also prevent
payment initialization/verification, outbox email/WhatsApp transport, and research email
transport even if credentials are accidentally copied into the environment. Add outbound
network denial at the UAT container/host as defense in depth. Do not configure production
scheduled maintenance, backup destinations, webhooks or shared provider callbacks.

This preparation does **not** implement a payment sandbox or message capture service.
The script's provider-dependent tests are **Blocked** until a separately approved test
adapter is implemented and verified. Synthetic ledger evidence is not a real payment,
refund, provider acceptance or delivery. Do not mark those cases Pass merely because
provider calls were suppressed. No installable native apps or mobile acceptance claimed.

## Admission and completion

- Keep production `/api/ready` and its production requirements unchanged.
- `/api/uat/ready` returns 404 when UAT mode is off; unsafe configuration, unreadable or
  invalid database, or absent active temporary admin/vendor/driver/support roles gives 503.
  A 200 response says only `ready-for-uat`, `externalProviders: disabled`, and
  `productionReady: false`; it is not production release approval or completed acceptance.
- This endpoint checks current access, so it is blocked before activation/start and again
  after expiry. It does not provision accounts or change data.
- Readiness is not the complete coordinator checklist. Verify two distinct vendor bindings
  and two distinct driver bindings for denial testing, restorable synthetic snapshot,
  authorized HTTPS host/proxy, visible environment label and correct UTC cohort window.
- Enable booking only on the admitted isolated instance when ready to run synthetic booking
  cases. Do not enable or alter production bookings.
- At the deadline verify fresh login, an already-open browser session, direct protected API
  request and refresh all deny access. Retain tester evidence and audit history. Restoration,
  extensions or a new cohort require deliberate authorized action; do not delete account
  rows to restore legacy fallback login.

## Local verification

Run the normal repository gates plus:

```
node --conditions=react-server --test --experimental-strip-types tests/uat-environment.test.mjs
node --conditions=react-server --experimental-strip-types --experimental-loader=./tests/alias-loader.mjs tests/uat-provider-boundary.integration.mjs
```

These use disposable synthetic files and stub external fetch; no real provider is contacted.

## Initial account issuance and limited UAT administration

The separate `staff_uat_accounts` table stores plain usernames (not fabricated email
addresses), password hashes, role/roster bindings, credential versions, status and a
fixed UTC start/deadline. Existing internal audit/session `email` keys carry the
username for compatibility; no email address or mail invitation is required. In UAT
mode, authentication resolves only these temporary identities, never permanent owner
or legacy staff identities. The account window is exactly 604800000 milliseconds;
normal sessions last at most eight hours and are capped at the account deadline.
Every protected request revalidates access. An already displayed page cannot erase
what a reviewer has already seen, but further protected requests are denied at expiry.
Expiry audit/credential cleanup is recorded on the next writable account lookup; the
security deadline does not depend on that housekeeping or a scheduler.

After the coordinator authorizes the host, cohort start and role accounts, an operator
can invoke `node --conditions=react-server --experimental-strip-types scripts/uat-account.mjs`
with a small JSON object through private standard input. No command-line arguments,
input files in the repository, passwords in shell history or terminal echo are accepted
as a credential-handling plan. The script creates no accounts when installed.

- Preferred reviewer issuance input: `action` = `issue`, `actor` and `accounts`, containing
  exactly one admin/vendor/driver/support entry, each with username/name/role/password
  and applicable entityId. Do not supply a start: the all-or-nothing issuance transaction
  records the actual server `issuedAt` and `expiresAt = issuedAt + 168 hours` for all four.
  It returns a password-free receipt. Draft preparation does not start this clock. Copy
  that receipt's times into the confidential document in UTC and Malabo time (UTC+1).
  If any account is invalid, no role access is issued. Never retry an uncertain issue
  operation without inspecting the recorded identities/audit first.
- Scheduled-fixture create input (not the reviewer issuance flow): `action` = `create`, `actor` = approved operator identifier, and `account`
  with `username`, `name`, `role`, `entityId` where needed, `password`, and `startsAt`.
  `startsAt` is an integer UTC epoch millisecond timestamp, not a relative duration;
  supply the same agreed cohort start to all issued role identities. Usernames are
  3–64 lowercase ASCII characters, starting with a letter, then letters/digits/._-.
  Passwords must be unique and 14–200 characters. Vendor and driver records must
  already exist in the synthetic roster. Prepare two vendor and two driver records
  for isolation cases; the second pair can be non-login boundary fixtures. If reciprocal
  login tests need extra identities, add those credentials to the same confidential table.
- Revoke input: `action` = `revoke`, `actor`, and `username`. This immediately disables
  further logins and existing sessions without deleting retained test history.
- The UAT admin can create and disable Vendor, Driver and Support test accounts in
  People & onboarding. New accounts inherit the original cohort start and deadline;
  they never receive a fresh seven-day window. The cohort limit is 20 accounts,
  including disabled identities. Vendor/driver accounts require existing synthetic
  roster records. Creation and revocation are audited.
- Admin/owner creation, password reset, deadline extension and reuse of any existing
  username are not supported. The production account-management gate stays closed
  to temporary users. A later cohort requires deliberate approval and new identities.

The requested single confidential lead-reviewer document contains the role credential
table. Until actual provisioning is authorized and performed, all credential cells must
say **NOT ISSUED**. When issued, restrict the document to its approved recipient; do not
copy credentials to test evidence, issue trackers or source. Shared role accounts prove
which role acted, not which individual engineer used it. Preserve that attribution
limitation in the handover. Do not place permanent owner or production credentials in it.

## Preparation verification — 26 October 2026

Candidate based on live application source `f7305933b15a285bbd393a2057bf5d27e4b9985c`.
Remote main `fd1b1a6` contains subsequent owner-renewal deployment controls; this local
preparation does not remove, overwrite, publish or deploy those controls. Production
remains unchanged. No real account, password, invitation or access grant was issued.

Verified locally with Node 22.23.4, the existing exact lockfile dependencies and Next
16.4.2: 490 unit tests, data/automation integration suites, dedicated UAT tests, the
workflow/failure/capacity/worklist suite, TypeScript and lint (zero errors; one existing
AdminMfaEnrollment navigation warning). Full and production dependency audits returned
zero vulnerabilities. Core UAT checks cover before-start/exact-deadline login, existing
sessions, capped session lifetime, manual revocation, no reset/extension, roster-bound
role routing, read-only readiness, denied sensitive APIs and zero provider fetches.

The compiled login HTML was checked for the synthetic banner, username-only field,
noindex and absence of demo/MFA controls. Browser rendering, responsive/keyboard and
interactive screenshot checks remain **unverified**: Chromium was blocked by platform
socket permissions and the permitted escalation failed in platform mount setup. This
limitation must be resolved in a working browser environment before reviewer admission.
Automated tests do not constitute completed human acceptance or deployment approval.

The confidential lead-reviewer UAT PDF/DOCX were updated in their existing Library
identities to version 3, preserving the branded test suite and adding role credentials
marked NOT ISSUED, explicit access boundaries and T01–T08 temporary-access cases. All
27 document pages were rendered and visually inspected. The configured host, actual
cohort start, issued role credentials, interactive browser evidence, deployed candidate
pin and human test results remain to be completed before this becomes an executable
handover. Provider-dependent and native-device scenarios remain explicitly blocked.


## Restricted test-site access and secure handoff

In UAT only, customer form submission, early access, privacy requests, customer
access/order/request/decision/delivery-code/recovery and private tracking require an
active temporary staff login. Existing customer cookies, private identifiers and
ownership checks still apply after this additional admission gate. This prevents
customer access from outliving the cohort deadline. Permanent invitation activation
is unavailable in UAT. Production behavior is unchanged.

`scripts/uat-seed.mjs --approved-synthetic-only` seeds two synthetic vendors and two
synthetic drivers only into an empty roster/store. It issues no logins and refuses
existing records. `scripts/uat-sealed-handover.mjs` supports a separately authorized
initial issue: four random passwords are sealed with RSA-OAEP-256 (minimum RSA3072)
and AES256-GCM, and the encrypted envelope commits in the same SQLite transaction
as the accounts. A lost transfer retrieves that same ciphertext for the same recipient;
it never changes passwords or restarts the deadline. Plaintext is never printed.
The private recipient key remains outside the repository. Operator stdout must be
captured and transported only through approved private storage, not workflow logs.

The additive installer under `ops/uat/` is separate from production release tools.
It verifies spare resources, fixed-path/user/port collisions, exact artifact contents,
Node22 and systemd unit syntax before creating isolated resources. It does not start
the service, change routes, enable bookings or issue accounts. The separate additive
`ops/add-uat-host.py` checks a pinned Caddy configuration digest and proves all other
routes unchanged; it defaults to no activation without explicit arguments. Actual
host capacity, confinement and routing verification remain prerequisites, not claims.
