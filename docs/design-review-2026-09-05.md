# Public design review

The previous public design used too many rounded panels and decorative layers. This revision uses open sections, compact headings, aligned rows and dividers on desktop, tablet and phones. Original Bubble Wash artwork remains in the shared branding and laundry image.

## Changes

- Homepage: concise business-laundry introduction, one unframed image, working pickup-area lookup, three open process steps and direct service links.
- Motion: short image arrival and a process divider that reveals on entry; reduced-motion preferences disable these effects.
- Pricing: monthly fee and processing rate are visible up front, plan details expand on demand, and each estimate link selects its plan.
- Estimator: neutral instructions, explicit success/error feedback, and stale responses discarded after selections change.
- Availability: paused and open states continue to use request-time flags. Staff access remains locked in production.
- Preview compatibility: the dev command accepts preview flags. Development supports local HTTP assets and same-origin responsive frames; production retains strict HTTPS, frame and script protections.

## Verification

Browser inspection covered 375px and 390px phone layouts, 768px tablet and desktop layouts. The mobile menu opened and closed with Escape. Tema coverage returned GH₵95; the Weekly plan at 60kg returned GH₵4,970 monthly. Responsive pricing forms were inspected, and the heading spacing and mobile image crop were corrected during review.

Lint, type checks, production build, unit and isolated data/workflow suites, image-runtime and required-route verification passed. Public HTTP checks cover six routes with staff-locked, booking-paused and open configurations. Production security headers have a regression check against accidental development-policy leakage.

Phone layouts were checked in browser frames, not on native iOS or Android devices. Screenshots show the paused production availability configuration. This revision is prepared for visual review before production deployment.

## Hero follow-up

The hero now uses `public/laundry-care-hero-blended.webp` (1200 × 960, approximately 119 KB). Its white background integrates with the page, and the complete laundry arrangement remains visible at all breakpoints. Browser review covered 390px, 768px and 1280px. The original square artwork remains available for existing social previews.
