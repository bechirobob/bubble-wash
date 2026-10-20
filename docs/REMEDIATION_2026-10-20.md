# Bubble Wash review candidate, 20 October 2026

This candidate is for review only. It does not deploy, reset production data, change credentials or enable payments. Base: 7a3c8d76486c86246d0696b7ff737b2bca07609e.

## Changes
- Checkout initialization distinguishes definitive rejection from uncertain provider outcomes. Safe failures can retry; uncertain outcomes require reconciliation. Locks cover persistence and notification handling, and stale locks cannot release another request's claim.
- Worker workspaces have compact responsive navigation, readable queue layouts, accessible route-map disclosure, admin-home links and corrected support scan routing. SLA countdowns stop at expiry rather than counting upward.
- Production dependencies and image-runtime assertions are updated. The full dependency audit remains enforced, without waiver.
- Synthetic four-role browser journeys cover booking, scheduling, assignment, intake, handoff, delivery, invoice reconciliation and closeout at 320px, 390px, WebKit mobile and 1440px. Provider egress is blocked; no real payments or messages are sent.
- Manual read-only inventory reports aggregate counts only, with SQLite query-only/read-only access. It is not a reset and has not been dispatched.
- Backup destination preflight now gives actionable missing-configuration diagnostics without exposing credential values. Backup/deployment execution remains unchanged and blocked where previously blocked.

## Validation
Local lint, unit/data tests, TypeScript and production build passed. HTTP workflow: 24 checks. Public availability: 45 checks. Backup transport/preflight: 25 tests. Inventory and browser-egress regressions passed. Image-runtime and required-route checks passed.

Production npm audit: zero findings. Full-tree npm audit: five high-severity development-tool findings from the unpatched braces dependency through Next ESLint. This blocks the existing Pilot CI full-audit gate and release readiness; no audit threshold was weakened.

Local browser launch is blocked by executor sandbox restrictions; WebKit also lacks host libraries. The dedicated browser CI must run and be reviewed before claiming browser validation. CI results on the published revision supersede this local snapshot.

## Separate reset boundary
Reset/authentication-readiness changes are not included. A separately approved fresh reset must remove operational records and nonadmin staff while preserving owner/admin authentication, service settings and infrastructure credentials, and excluding historical archives. Live owner access and runtime identity revocation require verification before any reset. This PR does not execute or authorize that reset.
