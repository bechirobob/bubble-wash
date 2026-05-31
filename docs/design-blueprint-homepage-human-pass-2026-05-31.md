# Bubble Wash Homepage Human-Factor Redesign Blueprint — 2026-05-31

## User goal and attention model
- Primary visitor wants to know three things fast: do you serve my area, what will it cost, and can I book/track without chasing people?
- Current page works but feels bulky because too many production capabilities appear as full sections.
- New flow should feel like a local Accra service with a serious operations backbone: short first impression, useful controls, human copy, then progressive disclosure.

## Principles
- Gestalt: group related actions into one command surface instead of scattering coverage, quote, track, booking, and payment across many separated cards.
- Fitts: keep primary CTAs large and close to decision points; quick area chips should remain one-tap checks.
- Cognitive load: collapse secondary details like vendor roster, onboarding, staff portal, and long FAQ into compact cards/details.
- Feedback loops: every helper control keeps visible pending/success/error states with `aria-live`.
- Progressive disclosure: show enough proof to trust the service, not every operational detail at once.

## Visual system tokens
- Type: use a warmer editorial pairing. Display: Space Grotesk for confident headings/tickets. Body: Manrope for readable, human operational copy.
- Scale: hero h1 56–76 desktop / 38–48 mobile; section h2 30–46; body 16–18.
- Spacing: reduce section vertical padding from bulky 86px to 56–68px desktop and 42–52px mobile.
- Radii: use 16–24px ticket/cards, not over-rounded generic SaaS blobs everywhere.
- Shadows: softer paper shadows; fewer layers above the fold.
- Color roles: cream paper base, navy dispatch panels, cyan/lime action accents, blue only for utility/trust states.

## Interaction and motion language
- Keep foam/washer motion but reduce global confetti. Motion should feel like soap/route movement, not random AI bubbles.
- Respect `prefers-reduced-motion`.
- Add a sticky mini action rail after hero on desktop/mobile: Coverage, Quote, Book, Track.
- Use `<details>` for vendor partners, commercial account, and staff access so the page does not demand scrolling through everything.

## Component map and data shape
- Keep existing data: plans, zones, addons, route preview, tracking, booking, payments, staff links.
- Replace bulky repeated sections with:
  1. Compact hero with coverage and live ticket visual.
  2. Action rail: Coverage / Quote / Book / Track.
  3. `customerFlow` three-step human story.
  4. Split panel: quote + booking/payment in one area.
  5. Trust drawer: vendors, coverage, payments, FAQ, staff access.
- Staff pages remain behind login; public homepage only advertises them quietly.

## Critique checklist
- Could still feel AI-made if copy stays generic. Use local Accra details and plain human phrases.
- Could hide too much if all forms collapse. Keep booking and coverage visible; collapse only secondary operations.
- Could break flows if IDs change. Preserve `#booking`, `#quote`, `#track`, `#locations`, `#plans`, `#faq` anchors.
- Verify coverage chips, quote API, booking submit, tracking lookup, payment missing/working state, mobile nav, console errors, and build.
