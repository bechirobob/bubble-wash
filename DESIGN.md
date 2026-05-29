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

## Critique checklist

- Buttons must not be decorative; every visible action navigates, submits, calculates, tracks, or opens contact.
- Mobile nav must open, expose links, and close after selecting a link.
- Form labels cannot rely only on placeholders.
- Public UI must not imply live payments/email until credentials are wired.
- Staff features must not crowd the customer conversion path.
- Public pages must not expose staff-only operational fields or customer records.
