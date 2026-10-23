# Bubble Wash collision intro candidate

Base: `59aca0381430c58c5df42a5a12ef073505f23415`.
Status: local candidate only. No source publication, merge or deployment authorized by this artifact.

## Design

Preserves the selected two translucent bubbles merging into the existing Bubble Wash logo. No altered lettering, additional image asset, animation dependency, UI shadow, global style change, sound, or storage writes. The existing icon is cropped only by an overflow window, retaining the complete original mark. Component and stylesheet total roughly 8 KiB of source including the eligibility helper, before bundling.

The actual home remains mounted and loads underneath a browser-native modal dialog. The sequence completes in 2.05 seconds including a brief handoff fade. Skip and Escape finish immediately. The native modal keeps background controls inert throughout that fade. This is progressive enhancement: without JavaScript or dialog support the page remains usable.

## Proposed playback baseline

Only a clean fresh-document home navigation or reload qualifies. Queries, fragments, initial non-home entries, history traversal, reduced motion, hidden documents, previously played documents, an already focused control, or an already scrolled page bypass the intro. This conservative policy is a proposed baseline, not a statement that the user approved a permanent playback policy.

The component is mounted only on the home route. No app data, checkout, survey, form draft, local storage, session storage, cookies, or history entries are changed. Visibility loss, pagehide, history/hash events, reduced-motion changes, asset error, and component unmount cancel the dialog without replay. Deferred startup avoids claiming a document during React StrictMode's development probe.

## Verification completed

- Focused eligibility tests: 21 passed.
- Focused ESLint: passed.
- Full TypeScript check: passed with the available dependency tree.
- Full ESLint: zero errors; one pre-existing AdminMfaEnrollment warning.
- Unit suite: 280 passed, one failed. The failure asserts the installed Next version is 16.4.2; the available restored dependency tree is 16.3.8. This is not a full green suite.
- Source diff whitespace check: passed.
- Motion-preview frames visually inspected. Preview is not a browser capture and does not establish runtime equivalence.

## Before release

Run `npm ci` against the pinned lockfile in the clean hosted environment, then the full required checks. Run the added `tests/browser/opening-intro.spec.mjs` against the actual build and existing synthetic fixture on mobile Chromium, desktop Chromium, and WebKit. Browser tests are supplied but have not run here because the restored local dependency tree lacks Playwright and browser binaries.

Acceptance must include real-home handoff, first-paint/hydration behavior (no objectionable content flash), exact CSS timing and bubble/logo proportions, focus containment/restoration, Skip touch/click without click-through, Escape, no page scroll behind the dialog, automatic finish, internal navigation without replay, history/BFCache restore, hidden-tab resume, reduced motion before/during playback, logo failure, JavaScript-disabled fallback, and preservation of booking/survey drafts. Capture runtime screenshots/video before approving a separate intro release.

The refined MP4 ends on the real logo; it deliberately does not invent a home screenshot. No claim is made that the local CSS implementation has already passed browser visual acceptance.
