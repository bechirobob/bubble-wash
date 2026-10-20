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

The development-only braces chain is replaced with an exact-version, project-scoped Next ESLint directory-glob adapter using glob and minimatch. This is not an official Next.js fix or a general fast-glob replacement. No lint rule or audit threshold is weakened. Compatibility tests exercise the actual Next internal-link rule. Review the adapter on every Next ESLint upgrade; see tooling/next-eslint-glob/README.md. Fresh full and production audits are required for the reconstructed revision.

Local browser launch is blocked by executor sandbox restrictions; WebKit also lacks host libraries. The dedicated browser CI must run and be reviewed before claiming browser validation. CI results on the published revision supersede this local snapshot.

## Reset preparation, not execution
Reviewed reset/authentication-readiness code and synthetic tests are included. Production workers must use active managed accounts; deleting a worker must not revive an environment login. Readiness accepts an empty worker roster while retaining effective admin and infrastructure checks. The guarded reset preparation covers operational records, customer recovery and checkout locks, and nonadmin staff while preserving owner/admin authentication, service settings and infrastructure credentials, excluding historical archives.

No reset, live credential/configuration change or deployment is performed by this PR. A separately authorized release and controlled writer freeze are required. The operator must verify live owner/admin password and MFA before and after execution, revoke old worker identities, and verify no reseeding. The source-level preflight is not proof of live owner access. See docs/FRESH_RESET.md.

Combined local validation: 102 unit tests plus all data integrations passed; reset-specific 18 cases cover unknown schema, drift, rollback, usable owner/MFA preservation and stopped-runtime checks. HTTP workflow, production build, required routes and image runtime rerun on integrated auth code. Rendered browser CI remains required for the final commit.

## Login hydration follow-up
Login controls remain disabled until hydration attaches handlers, with an explicit POST fallback and unnamed credential fields. Four no-JavaScript safety cases supplement the four full role journeys. The interrupted prehydration login cannot serialize credentials into the URL. The latest published browser failure occurred on synthetic data; no live credential exposure is inferred.

The follow-up was reconstructed from verified published source and retained reviewed code after local workspace loss. Prior results do not validate this reconstruction. Final fresh local and CI results must be checked for the exact published commit.
