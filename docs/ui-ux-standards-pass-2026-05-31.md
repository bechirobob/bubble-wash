# Bubble Wash UI/UX Standards Pass — 2026-05-31

## What will be done
- Connect homepage helper actions to the booking form instead of leaving them as isolated UI state.
- Preserve selected plan, coverage route/zone, and requested vendor as visible booking context.
- Keep backend payload validation aligned with the frontend fields that now carry context.
- Verify build, tests, and browser behavior locally.

## Why this approach
The new standards say visible actions must do real work and public forms must preserve critical context. Bubble Wash already has working ops/backends, so this pass should improve continuity without rebuilding the product.

## Files likely touched
- `src/app/page.tsx`
- `src/app/globals.css`
- possibly `src/app/api/submit/route.ts` if payload allowlists need new fields

## Expected outcome
A customer who selects a route, plan, or vendor sees that context carried into booking and submitted under safe allowlisted fields.

## Risks and mitigation
- Risk: controlled form values can accidentally block user edits. Mitigation: keep clear buttons and standard inputs/selects.
- Risk: backend rejects new fields. Mitigation: verify submit route allowlist and smoke test API.
- Risk: mobile layout cramps. Mitigation: add compact responsive CSS and browser inspect.

## Verification steps
- `npm test`
- `npm run lint`
- `npm run build`
- local API smoke tests
- browser smoke for homepage actions and console
