# Bubble Wash scaling path

## Current supported topology

The production-safe pilot topology is exactly one Next.js application process with one local persistent SQLite volume. WAL mode, atomic workflow claims, capacity reservations, one-use delivery proofs, and the durable notification outbox support the controlled Accra pilot. Multiple application replicas must not mount or copy this SQLite file.

## Move trigger

Begin the PostgreSQL move before any of these changes: a second application replica, a second city, multiple concurrent notification workers, sustained write-lock pressure, or an operating plan above 250 active orders per day. Start earlier if p95 write latency exceeds 250 ms or SQLite busy/locked errors appear in two consecutive operating days.

## Prepared migration assets

- `npm run db:export -- /secure/absolute/export-directory` creates a consistent, table-by-table JSONL export plus row-count manifest after `PRAGMA quick_check`.
- `db/postgres-schema.sql` is the target data-shape baseline. It intentionally does not claim to be a live adapter.
- The notification outbox and maintenance endpoint separate provider delivery from request acceptance. PostgreSQL workers must replace the SQLite read loop with transactional claims using `FOR UPDATE SKIP LOCKED` before more than one worker is started.

## Cutover sequence

1. Stop booking writes and drain the single application revision.
2. Run the encrypted off-site backup and require a successful restore proof.
3. Export the SQLite database and compare every manifest count with the source.
4. Load a private PostgreSQL staging database, convert JSON text columns to `jsonb`, and validate order timelines, capacity totals, open privacy cases, notification status, and delivery-proof state.
5. Implement the data-store and availability-store interfaces against PostgreSQL on a separate release branch. Do not dual-write in the pilot application.
6. Rehearse a full cutover and rollback with sanitized data, including customer access, MFA replay, workflow idempotency, retention, and one outbox worker.
7. During the production window, repeat steps 1–4, deploy one PostgreSQL-backed revision, run smoke tests, then add replicas only after the single-replica checks pass.

Rollback uses the pre-cutover encrypted SQLite backup and the previous single-replica application image. No PostgreSQL-era writes may be silently merged back into SQLite.
