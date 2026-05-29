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

- Type: Inter/system sans; compact tracking for display headings; 16px minimum form text on mobile.
- Spacing: section padding scales from 54px mobile to 86px desktop; card gaps 14–18px; touch targets at least 44px.
- Radius: 12px buttons, 18px cards, 22px mobile nav shell.
- Shadow: soft single-layer shadows for cards; remove heavy effects on mobile.
- Color roles: navy for authority, blue for actions, cyan for status accents, white cards over pale wash backgrounds, green only for success states.

## Interaction and motion language

- Smooth anchor navigation on desktop; reduced-motion disables animations and smooth scrolling.
- Hover uses transform/opacity only; active/tap state compresses slightly.
- Mobile avoids hero background animation, backdrop blur, and auto-scrolling testimonials.
- Form status messages use `role="status"`/`aria-live` so assistive tech gets feedback.

## Component map and data shape

- Public homepage: nav, hero/coverage, proof strip, plans, operations engine, services, vendors, locations, quote, assurance, tracking, booking, onboarding, testimonials, staff teaser, FAQ, payment strip, footer.
- Forms submit typed intent through `/api/submit`: pickup booking, checkout request, client onboarding.
- Quote uses `/api/quote` with plan, kg, zone, add-ons, and discount.
- Tracking uses `/api/track?id=` and displays only customer-safe fields.

## Compact refinement pass

- Mobile menu: treat the menu as a stateful overlay, not a hidden desktop nav. Use explicit open/closed visual state, `aria-expanded`, `aria-hidden`, Escape close, and close after link selection.
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

- User goal and attention model: make Bubble Wash feel like a command center for clean laundry, not a generic SaaS landing page. Above the fold should answer three questions fast: Can they pick up here? What will it cost? Can I track the job?
- Gestalt/Fitts/cognitive load: use a strong dark operations shell, bright high-contrast CTAs, grouped ticket/card modules, and large touch targets. Repeat the same action pattern: check, estimate, book, track.
- Typography tokens: use a sharper display face for headings and a calmer UI face for forms/body. Headings should feel engineered and local-operator serious; body copy must stay readable on phones.
- Spacing/radii/shadows: keep compact command-card spacing, slightly squared radii, stronger borders, and fewer soft template bubbles. Cards should feel like dispatch tickets rather than generic marketing cards.
- Color roles: navy command background, cyan action, lime/mint live-status accents, cream page warmth, blue-gray text. Avoid default purple/gradient AI slop.
- Interaction/motion: small transform/opacity only, no large paint-heavy mobile animations; reduced-motion keeps everything static.
- Component map/data shape: hero coverage checker, route preview, quote calculator, booking forms, tracking panel, staff login, and role dashboards stay intact while the skin becomes more distinctive.
- Critique risk: visual experiments cannot break forms, role auth, or mobile nav. If a redesign makes actions less obvious, it failed.

## Critique checklist

- Buttons must not be decorative; every visible action navigates, submits, calculates, tracks, or opens contact.
- Mobile nav must open, expose links, reflect hidden/open state, support Escape close, and close after selecting a link.
- Form labels cannot rely only on placeholders; tracking and quote inputs need visible labels or clearly grouped label text.
- Public UI must not imply live payments/email until credentials are wired.
- Staff features must not crowd the customer conversion path.
- Public pages must not expose staff-only operational fields or customer records.
- API routes must fail closed on invalid plan, zone, discount, add-on, and quantity inputs.
