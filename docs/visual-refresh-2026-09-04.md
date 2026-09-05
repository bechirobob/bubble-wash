# Bubble Wash visual refresh

Historical release notes. The layout is superseded by `design-review-2026-09-05.md`.

The public experience now uses a cotton-white, aqua and blue palette, laundry photography, rounded service panels, fabric-label details and shorter customer-facing copy. The homepage focuses on business laundry; household early access remains clearly separate.

## Brand and imagery

The original `public/bubble-wash-icon.jpg` remains the brand artwork in the shared header/footer component and staff surfaces. The icon is displayed larger, with its surrounding whitespace cropped in CSS and multiply blending to integrate its white canvas. The accessible brand name remains available to screen readers. No replacement logo was introduced.

`public/laundry-care-hero.webp` is an optimized 1200 × 1200 concept image, approximately 116 KB. It uses the original icon as a reference for the printed laundry bag. The image is conceptual marketing artwork, not evidence of a real facility or actual packaging. Next Image provides responsive delivery and prioritizes the hero. The social sharing preview uses the same image.

## Customer experience

- Homepage: “Fresh laundry. One less thing to manage.”
- Services: “Fresh laundry, on your schedule.” Clearer descriptions of actual weight, pickup confirmation and costs; prices and terms are preserved.
- Tracking: “Follow your laundry.”
- Manage order: “Your order, all in one place.”
- Booking: shorter plan questions and instructions, with a dedicated paused introduction.
- Public header/footer availability is resolved on each server request. Homepage, header and footer direct visitors to services while either the staff lock or booking lock is active. When both are off, pickup actions return automatically.
- Original staff login lock, booking enforcement, payment configuration and operational workflows remain unchanged.

## Verification

Production build, lint, existing unit and order-workflow checks, plus public HTTP checks covering six routes under both independent booking locks and the open state. Tests use an isolated local database. The cloud browser cannot access the local server; live visual inspection follows deployment. Native iPhone/Android testing is not represented by these checks.
