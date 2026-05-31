# Bubble Wash UI/UX Blueprint — Standards Pass

## 1. User goal and attention model
- Customer goal: confirm route coverage, estimate cost, book pickup, and later track/pay without retyping the same context.
- Staff goal: receive a single order record with plan, zone, area, vendor preference, payment preference, and notes preserved.
- Attention model: one short public path — coverage → plan/quote → booking — with detail panels available when needed.

## 2. Principles
- Gestalt: group selected plan/route/vendor as one booking context block near the form.
- Fitts: keep high-value controls large and close to the form they affect.
- Cognitive load: avoid making users remember what they selected above the fold.
- Feedback loops: every helper action should set visible state, update form fields, and announce status with `aria-live`.

## 3. Visual system tokens
- Type: keep existing premium service scale; avoid oversized new headings.
- Spacing: compact context block with 12–16px internal gaps.
- Radii: match current 18px card/button system.
- Shadows: reuse `--shadow`; no heavy new glass effects.
- Color roles: route/plan/vendor context uses soft blue/white cards with dark ink and success accents.

## 4. Interaction and motion
- Helper chips: update route preview and booking fields immediately.
- Plan cards: update estimator and booking preferred plan.
- Vendor request: show persistent booking context with a clear action.
- Reduced motion: existing global reduced-motion fallback remains enough; new elements do not need animation.

## 5. Component map and data shape
- Homepage state: `bookingPlan`, `bookingZone`, `bookingArea`, `requestedVendor`.
- Booking form fields: `preferredPlan`, `zone`, `area`, `requestedVendor`.
- Status fields: coverage/plan/vendor messages already use role/status patterns.

## 6. Critique checklist
- Does a selected plan actually show in booking? If not, cursed.
- Does a coverage chip fill booking zone/area? If not, helper is cosmetic.
- Can users still override the booking fields? Yes.
- Does the backend preserve the fields? Verify with API smoke.
- Does mobile become cramped? Check in browser.
