# Synthetic browser fixture

The browser suite uses fresh temporary SQLite data, synthetic staff identities and loopback-only services. It never uses production credentials, provider integrations or real transactions. External browser requests and server egress are blocked.

The HTTP fixture edge on localhost:3100 forwards to Next.js on localhost:3101. Only exact same-origin API mutation Origins are translated to the HTTPS origin expected behind the production TLS edge. Other Origins remain unchanged, so the application's same-origin guard rejects them. Host, cookies and request bodies are preserved.

Because this fixture deliberately uses local HTTP, its edge removes only the `upgrade-insecure-requests` CSP directive and the `Strict-Transport-Security` response header. WebKit otherwise upgrades localhost subresources to HTTPS, which this fixture does not serve. All other CSP directives and security headers are preserved; production application headers are unchanged and regression-tested. See the [Playwright WebKit localhost issue](https://github.com/microsoft/playwright/issues/12975).

This is transport emulation, not production TLS validation. The suite does not test certificate trust, HTTPS upgrades or HSTS enforcement, and does not ignore certificate errors or bypass browser warnings. Production transport requires separate verification.

After building, run `node tests/browser/fixture-smoke.mjs` before `npm run test:browser`. The preflight checks real HTTP script assets, four logins, cookie-backed workspaces, redirects and cross-origin rejection. The rendered suite retains all four viewport/browser projects, complete saved workflows and no-JavaScript login safety checks.
