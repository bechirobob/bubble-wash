# Bubble Wash UI/UX Blueprint

## User goal and attention model

- Primary user: Accra household or commercial operator who wants pickup, price confidence, and order visibility without calling support.
- First-screen priority: coverage check, pickup booking, quote estimate, and clear proof that orders are trackable.
- Staff/operator priority: public page stays customer-focused; admin, vendor, and support actions stay behind login.

## Design principles

- Gestalt: group quote, booking, tracking, and assurance into clear card regions with consistent spacing and labels.
- Fitts: keep primary CTAs large, full-width on mobile, and close to related copy/forms.
- Cognitive load: reduce long paragraphs, expose step-by-step service flow, and make status messages visible next to the action that produced them.
- Feedback loops: every form submission, estimate, coverage check, vendor choice, and tracking lookup must visibly confirm success or failure.

## Visual system tokens

- Type: native Apple/system stack; compact headings, 16px-class body copy, and 44px form controls.
- Spacing: public sections use 32–64px vertical rhythm; staff sections use 28–34px; information density comes from alignment and dividers rather than nested cards.
- Radius: 4–10px only where a control needs an edge; content regions stay square and unboxed.
- Shadow: none on content or navigation. Tight rings remain only on functional live-map markers, and the loading shimmer remains a status cue.
- Brand: the shared Bubble Wash artwork is cropped for legibility but has no border, background tile, radius, or visible container on public, login, or staff surfaces.
- Color roles: deep blue-green for actions and hierarchy, white surfaces, gray-blue text, and semantic green/amber/red only for status.

## Staff workspace production correction

- Research notes: Rinse and Hamperapp organize customer flows around pickup, service, tracking/proof, and simple CTAs; Poplin reduces the buying path to “start order” and service facts; Laundry Boss presents operator tools as dashboard/business-intelligence modules, not tutorial cards.
- User goal and attention model: trained staff should scan queue, SLA, route/customer facts, and action rail. They do not need each tile to explain itself.
- Principles: remove redundant descriptions, keep manual tools collapsed, and let actions/status/timers carry the workflow. Gestalt grouping becomes `Metrics → Orders → Exceptions`; Fitts favors one strong action rail per order; feedback is concise: saved, failed, refreshed.
- Visual system tokens: white ledger surface, compact rows, clear countdown numerals, restrained metadata, and color only for SLA state/action priority.
- Interaction and motion: SLA timers must be real client-side countdowns from persisted stage timestamps/targets, not static labels. Reduced-motion keeps the same information without decorative movement.
- Component map/data shape: `SharedOrderBoard` shows role metrics, current-stage countdown, customer/order facts, action buttons, and collapsible timeline. `PortalShell` trims role copy. Manual forms collect exceptions only.
- Critique checklist: if a card reads like onboarding copy, cut it; if the SLA is not counting down, fix it; if staff cannot act without scrolling through explanations, the board failed.

## Interaction and motion language

- Smooth anchor navigation on desktop; reduced-motion disables animations and smooth scrolling.
- Hover uses transform/opacity only; active/tap state compresses slightly.
- Mobile avoids hero background animation, backdrop blur, and auto-scrolling testimonials.
- Form status messages use `role="status"`/`aria-live` so assistive tech gets feedback.

## Component map and data shape

- Public homepage: nav, hero/coverage, proof strip, plans, operations engine, services, vendors, locations, quote, assurance, tracking, booking, onboarding, testimonials, staff teaser, FAQ, payment strip, footer.
- Forms submit typed intent through `/api/submit`: pickup booking, checkout request, client onboarding.
- The booking flow asks four operational-fit questions, recommends a plan with reasons, and lets the customer override it. The supplied bag defines customer-facing load capacity; intake weight remains an operational billing fact rather than a booking question.
- Exact pickup location is collected once. `/api/submit` derives the locality, concentration-cluster key, and route zone on the server so customers do not select an area and cannot spoof routing analytics.
- The separate pricing estimator uses `/api/quote` with plan, kg, zone, add-ons, and discount. Booking does not depend on a customer-entered weight estimate.
- Payments use `/api/payments/initialize` and `/api/payments/verify` against Paystack transactions in GHS with card/mobile money channels. Initial checkout covers the selected plan service fee; processing is billed from verified intake.
- Notifications use Resend email and WhatsApp Cloud API from server-only provider wrappers; missing credentials must skip safely and report setup status instead of pretending messages were sent.
- Tracking uses `/api/track?id=` and displays only customer-safe fields.

## Compact refinement pass

- Mobile menu: use a compact in-flow disclosure beneath the header with explicit open/closed state, `aria-expanded`, Escape close, and close after link selection.
- Bulky sections: operations, service handling, and assurance should read as compact proof modules. Shorten copy, reduce card padding, and let cards scan like operational receipts instead of essays.
- Vendor trust: use image-backed cards with opaque overlays so partner cards feel more like real laundry operations while keeping text legible.
- Payment lanes: use recognizable payment badges/icons for card, mobile money, bank, and invoice lanes. Keep accessible labels for screen readers, but avoid spelling every lane as plain text chips.

## Release standards pass

- Frontend: every interactive control needs semantic HTML, visible labels or equivalent accessible names, keyboard/focus states, disabled/pending states, and reduced-motion behavior.
- Mobile: menu state must be exposed with `aria-expanded`, hidden state must be reflected for assistive tech, Escape should close the menu, and tap targets remain at least 44px.
- UX: quick actions should do the complete job, not just decorate the page. Coverage chips should run the same route preview flow as typed search.
- Backend: public API inputs must validate allowed enum values and numeric ranges before reaching domain logic, return safe JSON errors, and avoid stack traces.
- Production metadata: share URLs should point at the stable Bubble Wash domain, not old tunnel URLs.

## Outside-the-box visual direction

- User goal and attention model: make Bubble Wash feel like a practical laundry operations service. Above the fold should answer three questions fast: Can they pick up here? What will it cost? Can I track the job?
- Gestalt/Fitts/cognitive load: use a strong dark operations shell, bright high-contrast CTAs, grouped ticket/card modules, and large touch targets. Repeat the same action pattern: check, estimate, book, track.
- Typography tokens: use a sharper display face for headings and a calmer UI face for forms/body. Headings should feel engineered and local-operator serious; body copy must stay readable on phones.
- Spacing/radii/shadows: keep compact command-card spacing, slightly squared radii, stronger borders, and fewer soft template bubbles. Cards should feel like dispatch tickets rather than generic marketing cards.
- Color roles: navy command background, cyan action, lime/mint live-status accents, cream page warmth, blue-gray text. Avoid default purple/gradient AI slop.
- Interaction/motion: small transform/opacity only, no large paint-heavy mobile animations; reduced-motion keeps everything static.
- Component map/data shape: hero coverage checker, route preview, quote calculator, booking forms, tracking panel, staff login, and role dashboards stay intact while the skin becomes more distinctive.
- Memorable homepage layer: Bubble Wash should carry its icon and bubble motif everywhere — browser tab, install metadata, nav, hero, footer, and share previews. Bubbles are used as spatial memory: floating foam, lens-like route orbs, soap trails, section foam seams, and handwritten operational notes; never as generic AI confetti.
- Long-page navigation: a persistent back-to-top control must be available after scrolling distance so visitors can recover quickly from the long homepage without hunting for the nav.
- Interaction/motion: bubble effects drift with opacity/transform only, pause on hover where useful, and shut off under `prefers-reduced-motion`. The hero should feel alive, but not slow the booking form.
- Critique risk: visual experiments cannot break forms, role auth, or mobile nav. If a redesign makes actions less obvious, it failed.

## Staff workflow target

- Access control: admin can open every staff section for oversight. Vendor, driver, and support stay in their own sections unless a specific API action lets them participate.
- Support tickets: admin, vendor, and driver can raise tickets tied to an order. Support owns the desk and can attend, assign, escalate, de-escalate, wait on a party, resolve, close, and reopen.
- Ticket state model: Open → In Review/Assigned/Waiting on Customer/Waiting on Vendor/Waiting on Driver → Escalated or Resolved → Closed/Reopened.
- Order workflow: use one shared Order ID and a deterministic state machine: Received → Pickup Scheduled → Vendor Assigned → Vendor Accepted → Driver En Route → Picked Up → At Vendor → Washing → Ready → Out for Delivery → Delivered → Closed, with Needs Attention as an exception lane.
- Automation workflow: customer booking is the source of truth. Staff should not re-enter customer, area, contact, payment, pickup window, or Order ID fields when those were already captured; role dashboards should offer one-click actions that append the next event with inherited order context.
- Assignment workflow: admin auto-assignment should choose from SQLite-backed vendor/driver availability tables with capacity remaining, service zones, service types, and status; vendors can accept or decline assignments, and declines return the order to Needs Attention for admin reassignment.
- Driver roster rule: drivers are onboarded only through admin (`driver-onboarding`) before dispatch automation can attach them to orders; active driver rows include route slots, zones, vehicle, and availability status.
- Automation implementation principle: automate predictable state transitions server-side, keep humans in the loop for exceptions/new facts, make role dashboards show only the next valid actions, and use event logs/timelines for auditability instead of overwriting history.
- Operational exceptions: manual inputs are only for new facts that were not in the initial order, such as vendor exceptions, bag-count mismatch, delay reason, payment reference, stain/damage notes, or customer escalation outcome.
- Timers: show elapsed time in the current stage plus SLA state. Internal staff see due/overdue labels; customer tracking keeps it simpler with delivery windows and next step.
- Maps: the pilot uses privacy-safe Google Maps URL search/directions plus explicit, rider-authorized foreground GPS for the currently bound rider. Dispatch stores only the latest accepted point, exposes it only to Admin and that rider, clears or redacts it when stopped/stale/unassigned/completed, and never claims background tracking, live traffic, or optimized routing. HTTPS, rider consent/training, and the approved retention policy are release requirements.

## 2026-07-09 public homepage correction — prototype-first, no speed-run

### User goal and attention model

- Primary goal: a customer should decide quickly whether Bubble Wash can pick up, roughly what it costs, and how to book/track without reading a long SaaS-style sales page.
- Attention order: 1) coverage + book, 2) order-trail proof, 3) three-handoff service explanation, 4) compact pickup desk for price/route/track, 5) booking form.
- Staff and operational detail remain behind `/staff`, `/admin`, `/vendors`, `/drivers`, and `/support`; the public home should not feel like a staff dashboard.

### Design principles

- Gestalt: match the uploaded static prototype — topbar, large two-column hero, paper order sheet, stats strip, then a compact service flow.
- Fitts: keep `Book pickup`, `Check coverage`, and `Run estimate` close to their related inputs with full-width mobile buttons.
- Cognitive load: remove the old giant menu-desk/pricing slab from visible homepage flow; keep pricing/coverage/tracking as compact checks.
- Feedback loops: preserve real route preview, quote, tracking, and booking form status messages with `aria-live`.

### Visual system tokens

- Type scale: large compressed hero heading, compact uppercase labels, readable form text at 16px minimum.
- Spacing: prototype-width shell around 1180px, generous hero whitespace, thinner row dividers, tighter post-hero sections.
- Geometry: rectangular buttons/cards, minimal radius, no pill-cloud rows, no decorative card wall.
- Shadows/colors: navy/teal/warm paper, restrained shadows only for order sheet depth, no generic gradient SaaS dashboard look.

### Interaction and motion

- Keep anchor navigation simple: pricing/coverage/track now land on the compact public pickup desk, not the hidden legacy menu slab.
- Reduced-motion fallback remains required; decoration must not block forms or become the design.
- Controls must do real work: coverage hits route preview, estimate hits quote API, tracking hits track API, booking submits pickup.

### Component map and data shape

- `src/app/page.tsx`: public home, coverage, quote, track, booking.
- `src/app/globals.css`: prototype-aligned public shell and compact pickup desk styles.
- Keep existing APIs: `/api/route-preview`, `/api/quote`, `/api/track`, `/api/submit`.

### Critique checklist for this pass

- If a full-page screenshot still resembles the old long pricing/calculator homepage, the pass failed.
- If the first visible scroll after the hero is a giant old menu desk, the pass failed.
- If controls are decorative or disabled without explanation, the pass failed.
- If forbidden hotel/Lagos/AI-dashboard terms appear in source or data, the pass failed.
- If protected staff interiors are not verified after auth, the pass is incomplete.

## Critique checklist

- Buttons must not be decorative; every visible action navigates, submits, calculates, tracks, or opens contact.
- Mobile nav must open, expose links, reflect hidden/open state, support Escape close, and close after selecting a link.
- Form labels cannot rely only on placeholders; tracking and quote inputs need visible labels or clearly grouped label text.
- Public UI must not imply live payments/email until credentials are wired.
- Staff features must not crowd the customer conversion path.
- Public pages must not expose staff-only operational fields or customer records.
- API routes must fail closed on invalid plan, zone, discount, add-on, and quantity inputs.
- Payment checkout must never expose the Paystack secret key client-side; initialize and verify transactions only in route handlers.
- WhatsApp and email sends must be best-effort with clear provider status, not blockers that lose a booking if an external API is down.


## Production automation correction — no MVP-coded descriptions

- Research synthesis: Rinse, Hamperapp, Poplin, and Laundryheap keep customer journeys direct: address/coverage, order/start CTA, service facts, app/tracking, and delivery promise. They do not explain every tile once the action is obvious.
- Public UI: tiles should scan as service/status labels. Remove redundant card descriptions from services, operations, assurance, tracking, and staff entry cards unless the copy changes a decision.
- Staff UI: trained operators get metrics, SLA countdowns, order facts, route links, and next actions above the fold. Descriptive tooltips and “safe/pilot/demo” phrasing make the product look unfinished.
- Automation: order boards should refresh automatically, action buttons should append inherited-context events, and manual forms stay collapsed for exceptions/new facts only.
- SLA: countdowns must tick from persisted `updatedAt + targetMinutes`, with due/overdue styling. Static elapsed labels are not enough.
- Mobile motion: bubble/foam brand effects must still exist on mobile in a lighter layer; do not disable the whole motif unless `prefers-reduced-motion` is active.
- Paystack: test mode is acceptable pre-launch. Other “provider not configured” notices should not dominate customer UI; keep failures in API/status responses and deployment notes.

## 2026-05-31 frontend/backend standards execution plan

- What: tighten Bubble Wash release UX and public API validation without replacing the existing build.
- Why: frontend standards require every visible action to complete a real user flow, preserve accessible feedback, and avoid stale decorative state; backend standards require typed request bodies, allowlisted public fields, bounded values, and safe JSON errors.
- Files likely touched: `src/app/page.tsx`, `src/app/globals.css`, `src/app/api/submit/route.ts`, and this blueprint.
- Expected outcome: vendor request cards carry the chosen vendor into the booking payload, pickup date/window/payment inputs expose safer client-side constraints, public submit rejects non-object/unknown/staff-only fields instead of silently accepting cursed payloads, and successful bookings keep the same customer/order data contract.
- Approved sleep-mode scope: preserve the existing public/staff/product flows, validate concrete pickup windows, turn saved pickup references into immediate tracking guidance, reject malformed JSON and oversized public fields with safe `400` responses, and validate phone/window inputs server-side.
- Risks and mitigation: keep changes targeted, preserve current auth/payment/order routes, avoid new dependencies, and verify with lint, tests, build, and API smoke checks.
- Verification: run `npm run lint`, `npm test`, `npm run build`; smoke `/api/quote`, `/api/submit` valid payload with `requestedVendor`, and `/api/submit` invalid payload with staff-only/public-forbidden fields.

## 2026-05-31 mobile pricing/menu correction

- Screenshot critique: the pricing cards showed only the subscription fee and pickup rhythm, which made the plans hard to compare on mobile.
- Change: each plan card should expose audience fit, monthly pickup count, starting kg/rate, key features, and then the action button.
- Screenshot critique: the laundry desk tab row depended on horizontal scrolling, hiding tracking/FAQ/staff options off-screen.
- Change: use a wrapping/grid tab selector so every option is visible without side-scrolling.
- Map note: avoid fake map-like panels unless they show a real map or route action. Coverage should read as route details with Google Maps links, not a decorative map preview.
- Verification: mobile visual inspection should confirm no horizontal tab dependency and plan cards remain readable without excessive height.

## 2026-05-31 cross-platform pricing interaction correction

- User correction: the pricing/menu improvement must not be mobile-only. Desktop, tablet, and mobile should all read as deliberate product UI.
- Change: pricing cards behave as a cross-platform comparison board — four columns on wide screens, two on tablet, one on mobile.
- Interaction: selected plan state is visible on the cards and mirrored in a selected-plan workbench with an `Update estimate` action.
- Accessibility: tab controls, plan actions, and estimate actions keep visible focus states and live status feedback.
- Critique checklist: no hidden side-scroll for primary navigation, no empty pricing cards on any breakpoint, and no decorative card state without a real quote/selection flow.

## 2026-05-31 Lovable reference visual skin

- Reference: `https://bubblewash.lovable.app/` uses Instrument Sans, navy text, white/very-light-blue surfaces, restrained shadows, compact B2B cards, and clean rounded CTAs.
- Change: apply the reference visual language as a CSS skin over the current Bubble Wash app so existing customer, pricing, payment, tracking, staff, and API workflows remain intact.
- Tokens: `Instrument Sans`, white page base, navy `#0f1d2e`, soft slate body text, subtle `#e5e7eb` borders, black/navy primary buttons, smaller border radii than the previous bubbly build, and lighter shadows.
- Interaction: preserve selected pricing state, quote recalculation, menu panels, coverage chips, booking form, and staff links while making hover/focus states cleaner.
- Verification: lint, tests, build, local visual checks on desktop/tablet/mobile, functional quote/coverage smoke, then push and confirm live markers.

## 2026-05-31 bubble identity + staff workflow clarification

- Keep the Lovable-style calmer UI but restore visible Bubble Wash foam: fixed background bubbles, soap trail, and hero washer bubbles remain decorative (`aria-hidden`) and respect reduced motion.
- Staff workflow now presents the real operational model up front: one customer Order ID moves through Received → Schedule → Assign → Accept → Pickup → Wash → Ready → Deliver → Close.
- Automation-first rule: staff should use action-rail buttons before manual forms. Manual tools stay collapsed for exceptions, capacity changes, support cases, declines, delays, and count/payment issues.
- Admin cross-role access separates auth role from page/workflow role so an admin can preview vendor/driver/support lanes and still navigate back to Admin home without logging out.
- PDF/handoff alignment check: current staff pages still match the boss handoff scope — admin oversight, vendor capacity/job acceptance/decline, driver route updates, support ticket lifecycle, shared Order IDs, `/api/orders/advance`, availability, and role-scoped access.

## 2026-06-04 color, opacity, and foam-motion polish

- Research synthesis: Rinse uses a direct pickup-first hierarchy with calm high-contrast text; Tide Cleaners leans on bold primary actions and clear service categories; Poplin uses strong simple CTAs and motion as brand energy, not over content.
- User goal and attention model: preserve the approved Instrument Sans visual system while making the page feel cleaner and more premium on laptop/desktop and mobile.
- Color roles: warm linen page base, deep navy body/headings, high-contrast blue/navy CTAs, aqua as foam/status accent, amber only as a soft warmth layer. No pale text on cream panels.
- Opacity rule: text-bearing cards, forms, plan metrics, booking summaries, and estimate rows use near-opaque surfaces. Transparency is reserved for decorative background bubbles/trails.
- Motion rule: foam orbs and trails move diagonally/across the viewport using transform/background-position only; `prefers-reduced-motion` disables the motion. Bubbles stay behind content and must not cover forms or estimates.
- Verification: local lint/build pass, desktop 1366px and mobile 390px visual checks confirm the page loads, keeps the font, and does not block text with colors, opacity, or bubble effects.

## 2026-09-05 public layout correction

- Goal: customers on phones, tablets and desktops can identify the laundry service, check pickup coverage, compare costs and track an order quickly.
- Composition: compact introduction and one laundry image; a working coverage check; three unboxed service steps; concise business/home service links. Remove repeated slogan sections, pastel card grids, floating badges and decorative image frames.
- Tokens: white canvas, existing navy/teal actions and original icon; 32–38px phone heading, up to 48px desktop heading; 16px body; 32–56px section spacing; 4–6px control radii; no content rounding or shadows.
- Grouping: use proximity, aligned columns, numbered steps and dividers. Phone actions fill the available width; desktop actions stay near their context. Keep forms labelled and feedback adjacent.
- Motion: short image entry, subtle press feedback, and a one-time line reveal for the three-step explanation. Use transform/opacity only; keep content readable before scripts load and under reduced motion.
- Components: revise public homepage, public CSS, and customer copy. Reuse route-preview and pricing APIs. Preserve original brand artwork, login lock, booking rules, pricing values and staff workflows.
- Verification: inspect 375px, 390px, 768px and desktop layouts, menu open/close, coverage feedback, pricing interaction, reduced-motion CSS and production build. Reject overflow, repeated boxed content, excessive first-screen height, tiny controls or decorative actions.

## Hero integration and design references

- Start design and copy work with the relevant installed skills and this blueprint. Read the actual instructions; report a missing reference clearly rather than assuming its contents. Current user directions take precedence.
- Hero artwork sits directly on the white canvas on tablet and desktop. Use a seamless white background, preserve the original brand mark, and show complete objects. Hide the figure at 600px and below so the phone introduction leads directly into pickup coverage without an image section or reserved space. No rectangular blue backdrop, container, decorative frame or forced crop.

## Colour without containers

- Keep the live palette: pale blue `#edf5fc`, sage `#f2f6f0`, aqua `#e5f3f7`, teal `#086584` and headline accent `#157e9d`.
- Use full-width colour bands for pickup coverage and service choices, with aqua introductions on the other public pages. The content remains aligned to the shared page width, without rounded cards, borders or shadows. Keep the introduction white for seamless artwork integration and the process on white for visual breathing room.
- Retain the phone image removal, readable contrast, original branding and existing availability controls.
