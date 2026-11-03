# Customer journey completion — source candidate, not released

This follow-up is separate from the successful runtime1406b0e deployment. Base153f2d74 contains the release controls but no further application changes. The goal is to finish demonstrated customer interaction gaps, preserving Bubble's identity, public composition and business rules. No API, permission, payment, pricing, production configuration or dependency changes are included.

## Implemented

- Public menu returns focus on Escape and remounts closed on pathname changes.
- Tracking and order-access inputs say “Paste private code” rather than implying a BW reference unlocks access.
- Tracking uses one cancellable latest-request path, 15-second timeout and in-memory retry. Tokens leave the address bar without discarding browser history state; no token storage is added.
- Initial customer recovery runs once across effect setup/cleanup, times out safely and never replays a possibly consumed token. Access controls wait for the initial result; error guidance unlocks fresh access/recovery. Email-link feedback is adjacent to its form.
- Booking confirmation receives focus after success; duplicated introductory instructions are reduced.
- Privacy requests distinguish pending, failure and success explicitly, independent of server wording.

## Route acceptance ledger

“Retained” below means source-reviewed without a demonstrated reason for a visual redesign. It does not mean fresh pixels have passed.

| Route / state | Source disposition | Candidate verification / remaining gate |
| --- | --- | --- |
| Home and public header; menu open/closed | Header changed; brand, imagery, colour bands and home layout retained | Escape/navigation regression added; 320/390/desktop/WebKit screenshots and enlarged text blocked pending permitted browser CI |
| Services; catalogue, extras, estimate, booking link | Comparison choices changed to native single-select radios; pricing retained | Existing catalogue tests plus new booking/Back selection regression; actual Back behavior and pixels unverified |
| Booking available; failed submit and confirmation | Focus/copy changed | New failure/draft/idempotency/focus test; available only in synthetic fixture, production pause unchanged; browser execution pending |
| Booking paused | Retained | Existing availability HTTP regression; fresh paused-state pixels still required |
| Tracking; link loading, error, retry, stale response, result | Changed | Synthetic transport regressions including timeout; error/result screenshots prepared, not yet captured |
| Manage; initial session, token recovery, expired/lost response, email recovery | Changed | One-shot/timeout/error/success tests, expanded recovered-order screenshot prepared; no token replay or auth change |
| Manage; signed-in request, invoice/history | Existing request refinement retained | Existing long-content, retry and bounded-list tests remain; full candidate browser regression/pixel review required |
| Early access; consent, error, success/update | Retained | Existing public-service journeys; route expanded/enlarged baseline added; candidate pixels pending |
| Privacy; form pending/error/success | Changed | New unfamiliar-error/draft/reset test and existing real disposable-handler journey; pixels pending |
| Terms, refund policy, installation guidance | Retained | Expanded-route/enlarged-text capture added; pixels pending |
| Staff, survey and role separation | Previous released behavior retained | Full existing browser regression remains required; this pass does not rebrand or rewrite these areas |

## Validation boundary

Local typecheck, full lint (one pre-existing AdminMfaEnrollment navigation warning), unit517 tests, data/HTTP suite, automation23 tests and production build passed. Isolated test-environment security/provider tests passed without external requests. Full workflow suite, native image-runtime check and required-route verification also passed. No external provider calls were made by the fixture suites.

Three new browser files discover84 cases across four existing projects. Discovery is not execution. Public route screenshots include native menu/disclosure expansion and simulated200% text enlargement; this is not physical-device/browser-zoom validation. Existing outcome-specific suites complement the route baseline. Screenshots must be inspected and any demonstrated defect fixed before claiming full-app completion.

The current task is restricted to source work with no publication or deployment. Earlier task instructions keep browser execution in the prepared GitHub environment; no browser was installed/launched and no sandbox bypass attempted. Hosted browser execution and independent screenshot acceptance remain blocked until a permitted publication/CI step is authorized. No security source-admission record has been widened or refreshed for this new source.

## Content dependency from independent live review

The public privacy, terms and refund-policy pages say operator details “will be published here.” Accurate legal/operator information remains a content launch dependency; this UI patch neither invents that information nor changes privacy commitments. Independent desktop live review found home/services/tracking/manage with expanded recovery/early-access/privacy visually clean, but does not cover this local candidate's dynamic outcomes or mobile layouts. Paused-booking review used no guessed link or live submission; available-booking acceptance remains synthetic-fixture work.

## Final comparison correction and error checks

Source confirmed that comparison choices were pressed-state buttons, not actual checkbox inputs; all choices already selected one shared plan. They now use a native radio group with a label and arrow-key behavior, synchronized with the top frequency selector and calculator. Pricing and available choices are unchanged. Native keyboard interaction is covered by the updated browser regression; actual pixels and execution remain pending.

After an authorized push: inspect exact-head CI, TypeScript/lint/build results, test failures, browser page errors and failed network requests; no green-by-assumption. After a separately authorized exact deployment: verify release identity/service health and read-only public/customer/staff entry routes; inspect approved bounded/redacted browser/runtime error evidence. Do not read raw logs that may contain secrets/customer data, submit live forms, replay recovery tokens, or call mutating readiness endpoints. Report activation separately from completion of this audit. These checks are required by the user's Nov3 request and do not waive any publication or release gate.

## Customer error collection (test-only follow-up)

The three new customer spec files share a bounded error collector. Every uncaught page error, failed script request and unexpected HTTP/transport failure fails the test. Intentional fixture errors are declared per test with same-origin path/method and exact HTTP status; these allowances never exempt JavaScript exceptions or failed scripts. Console warnings/errors remain visible diagnostics, not a universal console-error assertion. Details are capped at60 while the unexpected-event count is uncapped; absolute/relative URL query and fragment values are removed from diagnostic text. Network allowances describe event shapes, not occurrence counts; one-shot recovery tests separately assert request counts. Local520 unit tests and scoped lint pass. Hosted execution of this collector remains required; prior screenshots validate unchanged application bytes only.

## Full-suite findings and combined correction

Run41553217969 at9566abee completed with92 targeted checks and10 worklist checks passing; the full suite had329 passes,40 intentional skips and11 failures. Preserve this failed run:5 enlarged-text overflow failures (early access320, privacy320, terms320/390/WebKit390),4 pricing Back state-loss failures,1 WebKit tracking-timeout failure,1 WebKit staff dispatch-location pageerror. The later open-survey stage was skipped.

The combined candidate wraps long public/policy/early-access headings and allows form tracks to shrink without clipping or reducing text size. Pricing restores validated plan/zone/weight/extras from the same browser-history entry, preserving framework state; no identity/payment data or persistent local/session storage is added, and no quote/API call is restored automatically. Tracking has an independent15-second UI deadline so retry does not depend on an aborted transport rejecting; plain-language transport failures preserve server validation messages.

The staff error coincided with hard navigation9ms after the prior RSC-only quiet guard. This is a navigation-collision hypothesis, not proven CORS or authorization failure. Test observation now includes exact same-origin dispatch GET lifecycles/status, preserving strict failure and pageerror assertions. No staff application or access configuration changed.

Expanded-state capture now uses stable summary locators so opening one disclosure cannot skip the next. Enlarged-text screenshots and bounded overflow rectangles are captured before the unchanged containment assertion; pricing return and tracking-timeout diagnostics are likewise available on failure. Prior pre-enlargement images do not prove enlarged-text correctness. Final combined browser/pixel verification remains mandatory.
