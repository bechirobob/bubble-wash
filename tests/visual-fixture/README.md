# Actual-component visual fixture

Run from repository root: `node tests/visual-fixture/build.cjs`.

Serve only `tests/visual-fixture/dist/` through the authorized private preview channel. No publication is performed by the build. Use `?role=admin`, `?role=vendor`, `?role=driver`, or `?role=support`; existing `view`, `case`, `order`, and `activity` parameters work through fixture-only Next navigation adapters.

The bundle imports the actual four React workspace components and their real CSS. It does not recreate the interface with mock markup. The only component replacements are Next Link/Image/navigation browser adapters because this isolated preview has no Next server. Order and support records are synthetic and shaped from the source component/API contracts. A synthetic-fixture label sits outside `#app`; capture `#app` or `.staffDesk` for component pixels but retain the label in evidence documentation.

Fetch is intercepted before mounting. No production API, credentials, customer records, or authentication flows are used. All writes and unknown endpoints return errors; CSP also denies browser network connections and form submissions. This proves rendered component layout and read/navigation/disclosure behavior only, not production authentication or backend persistence. Form failures intentionally retain drafts. Geolocation/live sharing, phone links and external navigation must not be exercised as operational actions in this fixture.

Build, TypeScript and focused source lint passed. Browser runtime/render checks must be performed via the authorized hosted browser. Rebuild after any component or CSS changes; the bundled source is a snapshot, not a live dependency on the source tree. Generated `dist` is evidence output and should not be included in a production runtime release.
