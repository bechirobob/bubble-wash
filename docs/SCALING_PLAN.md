# Scaling plan

Bubble Wash now runs as a Cloudflare Worker with D1, so horizontal Worker execution is the default and there is no single-host SQLite lock or VPS replica limit.

## Current controls

- D1 statements and batches own durable writes.
- Database triggers validate and reserve paired vendor/rider capacity atomically.
- Unique keys make payment verification, workflow claims, delivery proof use, and vendor declines idempotent.
- Cloudflare rate-limit bindings absorb edge bursts; the D1 window is the exact application limit.
- Scheduled maintenance uses Worker cron and `waitUntil`.

## Growth gates

Before materially increasing traffic:

1. Measure D1 query latency and rows read/written for order, availability, and staff queues.
2. Add pagination where a route can exceed the current pilot caps.
3. Rehearse D1 Time Travel and export/import recovery at the expected data size.
4. Load-test concurrent assignment, payment webhook replay, customer lookup, and delivery-code consumption under Workerd.
5. Reduce observability sampling only after production volume justifies it; never log sensitive payloads.

Use Queues for high-volume notification delivery if the outbox exceeds cron throughput. Use Durable Objects only for coordination that genuinely requires a single ordered actor; do not move ordinary order records out of D1.
