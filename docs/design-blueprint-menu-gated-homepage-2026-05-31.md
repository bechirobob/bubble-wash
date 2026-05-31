# Bubble Wash menu-gated homepage blueprint — 2026-05-31

## User goal and attention model
- Primary visitor goal: confirm service fit, book pickup, or contact WhatsApp fast.
- Secondary goals: pricing, coverage map, order tracking, FAQ, and staff login should be available without making the homepage feel like a long portal.
- Attention model: the homepage should sell the promise first, then let the menu reveal deeper modules on demand.

## UX principles
- Gestalt: group deeper modules into one shared “menu desk” instead of scattering similar cards across the page.
- Fitts: keep Book and WhatsApp as large tap targets; menu-driven modules should have clear buttons and panel tabs.
- Cognitive load: show one deep module at a time. Do not make users parse pricing, coverage, tracking, vendor, FAQ, and staff sections all at once.
- Feedback loops: menu clicks visibly open the selected module; quote, coverage, track, payment, and forms keep status messages with `aria-live`.

## Visual system tokens
- Type: keep current rounded system stack; use big display type only for hero and module headings.
- Spacing: homepage sections should be tighter: 56–72px desktop, 36–48px mobile.
- Radii: retain soft laundry-card radii, but keep the new menu desk compact with 22–30px cards.
- Shadows: light operational-card shadows only; avoid stacking many heavy cards in one viewport.
- Color roles: cream/foam for public surfaces, blue for primary actions, navy/ink for active module and result panels.

## Interaction and motion
- Navigation links for Pricing, Coverage, Track, FAQ, and Staff open their module in the shared menu desk.
- Direct hero CTAs can also open the same module, but content no longer appears as separate long duplicated homepage sections.
- Reduced-motion fallback: existing smooth scroll is acceptable but should not be required for state changes.

## Component map and data shape
- `Home`: owns `activeMenuPanel` state and current quote/coverage/tracking/payment state.
- `menuDesk`: tab-style module selector and active content panel.
- Pricing panel: plan cards + quote workbench.
- Coverage panel: area chips, location chips, route preview map, vendor request cards.
- Track panel: order lookup + payment checkout drawer.
- FAQ panel: compact question list.
- Staff panel: role login cards.
- Booking section: remains visible because it is the primary conversion path.

## Critique checklist
- Does the homepage still explain what Bubble Wash does before asking users to click? Keep hero + 3-step story visible.
- Does menu-only access hide useful actions too much? Keep Book and WhatsApp persistent, and make the menu desk obvious.
- Did we preserve real backend flows? Verify quote, coverage, submit, track, and payment initialize behavior.
- Does mobile become easier? Check height and ensure active module controls are horizontally scrollable, not stacked forever.
