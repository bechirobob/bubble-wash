# Additive personal owner enrollment

This is a separate reviewed release, not part of the account-preserving rollout. It adds `staff_owner_capabilities`, whose rows explicitly enable all staff workspaces for an enrolled managed administrator. Existing environment/master administrators and every staff account keep their current permissions. No private recipient is embedded in source.

The owner remains an administrator, not a vendor or driver. Sessions resolve the current managed status and credential version on every request. Existing admin MFA requirements still apply. Personal owners never inherit the legacy master environment TOTP seed: when MFA is required, they enroll their own authenticator at `/admin/mfa/enroll` using their own password. Per-email recovery codes remain isolated. Operator workflow records use the authenticated personal name, email, and administrator role. Driver GPS publication/deletion still requires the actual bound driver account; owner access does not bypass it.

## Private host preflight

Use the existing trusted production host execution route and its existing application environment. Never put recipient, credentials, activation links, or provider responses in public workflow inputs, logs, artifacts, chat, or source control. Do not invent email configuration or provision provider credentials.

Privately supply `BUBBLEWASH_OWNER_EMAIL`, `BUBBLEWASH_OWNER_NAME`, and `BUBBLEWASH_OWNER_INVITED_BY`. Run `node --conditions=react-server --experimental-strip-types scripts/invite-additional-owner.mjs --check`.

The preflight opens the existing SQLite database read-only. It does not import the application database/store module or create tables, accounts, tokens, or messages. It fails on missing schema and reports fixed collision type/status categories for configured/master/managed accounts or matching onboarding roster email. Creation stops on any collision, which is rechecked in the immediate insertion transaction. It checks that the existing Resend key and an explicit Bubble Wash domain sender are present and the public origin is exactly https://bubblewash.co. It validates the existing MFA encryption key with the shared strict parser when admin MFA is required. It does not create or rotate a key, and does not validate the provider key remotely. Output is fixed flags, not personal addresses or secrets. Verify the actual sender privately before requesting delivery approval.

## Explicitly approved delivery only

Do not run this step until the exact account grant and direct email delivery are approved and independent review/release verification is complete. Set `BUBBLEWASH_OWNER_INVITE_CONFIRM` privately to the same recipient, and change `--check` to `--send`.

The script rechecks collisions, atomically inserts an invited admin and its capability, then sends a one-hour, single-use activation link through existing Resend configuration. Only a SHA-256 token digest is stored. No password is generated or accepted from an operator. The recipient sets their own password on the existing HTTPS activation page; the token is in the URL fragment, not a request URL. No plaintext token is persisted in the notification outbox.

Provider acceptance is not proof of delivery, activation, or successful login. A failed/uncertain send leaves a non-login invited row and stops. Do not rerun, reset, replace, or silently reuse an existing identity. Resolve uncertain delivery and any invitation expiry privately under separate authorization. This implementation deliberately has no automatic resend or account takeover path.

## Verification

`npm test` includes collision/preservation, single-use expiry, capability/status/session revocation, read-only preflight, and mocked delivery uncertainty tests. `npm run test:workflow` includes a synthetic owner workflow through existing evidence checks, complete staff page access, master permission non-expansion, actor attribution, and denied owner GPS publication. All fixtures use non-production databases; no real activation links are printed.
