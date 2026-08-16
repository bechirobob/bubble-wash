# Bubble Wash

Bubble Wash is the customer and operations product for Accra laundry pickup: service discovery, pricing, booking, order tracking, signed bag handoffs, customer self-service, staff workspaces, early access, privacy requests, and pilot billing.

## Architecture

- Next.js 16 and React 19 are compiled by Vinext for a Cloudflare Worker.
- D1 is the only production database. Trigger-backed reservations make vendor and rider capacity changes atomic.
- Cloudflare rate-limit bindings protect public, login, payment, and dispatch traffic; D1 provides exact application-window enforcement.
- Worker cron triggers retry notifications and apply retention rules.
- Staff credentials and role/entity bindings live in D1. Staff sessions are signed, eight-hour, `HttpOnly`, `Secure`, `SameSite=Lax` cookies; the browser never stores an admin token.
- Production releases are built and tested by GitHub Actions, then reconciled through the same Cloudflare account used by BeCore Tickets.

## Site map

- `/` is the landing page and contains the product overview and How it works.
- `/services` owns plans, coverage, service conditions, and estimates.
- `/book`, `/track`, `/manage`, and `/early-access` each own one customer task.
- `/staff` and `/login` lead to separate role-scoped admin, vendor, rider, and support workspaces.
- `/privacy`, `/terms`, and `/refund-policy` are canonical policy pages.

Public navigation links to these pages instead of duplicating their content on the landing page. The Apple touch icon is the shared visual mark across public and staff surfaces.

## Local development

```bash
npm ci
npm run db:migrate:local
npm run dev
```

Open the URL printed by Vite. Local D1 data is stored under Wrangler's local state directory.

## Release checks

```bash
npm run check
```

This runs lint, Node tests, Workerd/D1 integration tests, TypeScript, dependency audits, the Vinext production build, Worker packaging, and route verification. `npm run cf:types` must be rerun whenever bindings change.

## Operations

- `/api/health` is liveness and identifies the exact deployed SHA and hosting phase.
- `/api/ready` checks runtime configuration, D1, staff identities, admin MFA, and entity bindings. It returns 503 until the release can receive traffic.
- D1 time-travel bookmarks are preserved before deployments; `npm run db:export` creates an operator-requested SQL export.
- The one-time SQLite migration is GitHub-OIDC authenticated, allowlisted, count- and SHA-256-parity checked, and disabled in production after cutover.

See [docs/PILOT_RUNBOOK.md](docs/PILOT_RUNBOOK.md) for deployment, rollback, recovery, and incident procedures.
