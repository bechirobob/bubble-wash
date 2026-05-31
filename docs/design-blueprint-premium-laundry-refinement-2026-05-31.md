# Bubble Wash premium laundry refinement — design blueprint

## User goal and attention model
- Visitor goal: know if Bubble Wash serves their area, trust the service, estimate price, book pickup, then track/pay later.
- Boss/client goal: see a live site that feels like a real laundry service, not a generic SaaS template.
- Attention path: hero promise → coverage check → short service handoff → selected detail panel → booking.
- Design posture: calmer, more tactile, still operational. Preserve the bubble/foam motif as a brand signature.

## Reference synthesis
- Rinse: strong concise promise, immediate pickup/address action, trust proof, service steps, tracking/inventory confidence.
- Poplin: simple “tap and done” framing, fewer words, laundry-specific care assurances.
- Tide Cleaners: calm service categories, clean anytime/anywhere positioning, less interface noise.
- Laundryheap: direct 24h delivery promise and minimal conversion path.
- Hamperapp: broad service coverage/pricing content, but avoid its SEO-heavy density.

## Principles
- Gestalt: group pricing/coverage/tracking into one selected “laundry desk” so the default page stays light.
- Fitts: keep Book, Coverage, WhatsApp, and Calculate large enough for thumb use.
- Cognitive load: smaller typography, fewer shouting weights, calmer contrast; keep one primary action per cluster.
- Feedback loops: coverage, quote, tracking, booking, and payment keep live status text with `aria-live`.

## Visual system tokens
- Type: warm rounded sans, tighter scale. Hero max around 64px instead of 82px; body around 15–16px instead of 18px.
- Palette: laundry navy, linen/off-white, foam white, mist blue, muted teal. No loud rainbow palette.
- Accent: muted teal/blue for primary actions; darker ink for active tabs; warm linen for surfaces.
- Radius: 16–28px, with softer “laundry ticket” cards instead of generic oversized SaaS blobs.
- Shadow: low, warm, natural shadows; reduce heavy blue glow.

## Interaction and motion language
- Keep bubbles, but make them organic foam: translucent, varied sizes, slow drift, no confetti.
- Use transform/opacity only; reduced-motion disables drifting bubbles and heavy movement.
- Tabs and buttons remain accessible and keyboard-focusable.

## Component map and data shape
- Hero: coverage form, short promise, refined order/timeline card, care label cue.
- Proof strip: calm service metrics.
- Service flow: pickup, wash/care, return/track as tactile cards.
- Laundry desk: pricing/quote, coverage/vendors, track/payment, FAQ, staff.
- Booking: source-of-truth public order form preserved.

## Critique checklist
- Too generic? Add tactile laundry cues: care label, foam, linen surfaces, order ticket styling.
- Too colorful? Keep accent muted, remove bright gradients except very subtle wash depth.
- Text too big? Reduce global heading/body scale and excessive weight.
- Broken flow? Verify coverage chips, quote, tab panels, booking, payment, tracking, and live APIs.
