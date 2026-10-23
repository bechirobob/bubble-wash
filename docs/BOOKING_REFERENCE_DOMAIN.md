# Permanent booking references and vendor codes

## Domain contract

New root bookings receive one continuous human-readable label: `BW-001` through `BW-999`, then `BW-1000` and onward, bounded by JavaScript's safe integer range. Labels never reset by date, vendor, cancellation or cleanup. The existing random internal booking IDs, relationships, payment references, signed QR payloads and delivery proofs remain unchanged.

A label is not a credential. Public tracking must not resolve predictable labels without separate authorization. Reference lookup is only a display/search aid after the applicable customer or staff access check.

`saveBookingOnce` calculates the request hash without caller-supplied display labels. Within its existing immediate SQLite transaction it saves the new root, allocates its reference, records the idempotency key and delivery proof, and enqueues the same enriched record. A retry returns the committed mapping. A failed transaction consumes no committed number. Direct root append paths use the same atomic allocator; linked checkout/payment events do not allocate another booking number. A previously committed internal identity cannot be used for a new root.

The authoritative read projection removes persisted or submitted `bookingReference` and `vendorCode` values before looking up the domain maps. It never writes on read. Old records and old request replays have no mapping and return `null`. Legacy imports are not backfilled or rewritten. Existing test records must not be deleted or renumbered without a separate inventory and decision.

New vendor identities receive unique three-letter uppercase codes in the finite domain `AAA` through `ZZZ` (17,576 codes). The preferred code is the first three ASCII letters after NFKD normalization, removal of combining marks, and uppercasing. Short or non-Latin-only names use the neutral preferred code `VND`. If the preferred code is taken, search the same two-letter prefix from `A` to `Z`, then subsequent prefixes, wrapping through the complete namespace. For example, `ABC` is preferred before `ABA`, `ABB`, and subsequent unused candidates. The mapping is tied to the stable vendor ID, not its mutable name. Renaming/updating a vendor preserves its code; exhaustion rejects the new vendor transaction. Existing vendors are not rewritten or automatically assigned a code. Any later assignment of codes to them needs a separately reviewed inventory.

The two additive mapping tables use permanent AUTOINCREMENT high-water marks. There is intentionally no cascading foreign key to operational records: removing a record must not free its reference. No application API updates or deletes mappings. Tables are trigger-free so the existing owner-enrollment prohibition on triggers remains intact. Readiness checks exact table/index definitions, mapping high-water consistency and valid unique three-letter vendor codes. Partial or unexpected map schemas fail closed.

## Explicit migration and startup

Only a genuinely empty new database bootstraps the maps with the rest of its initial schema. Opening an existing database does not install or backfill them. New application readiness requires both exact maps. The offline migration supports both exact legacy and exact additive outbox schemas, and adds empty maps only.

The read-only inventory entrypoint is:

```sh
node --conditions=react-server --experimental-strip-types scripts/migrate-booking-references.mjs --inventory --database /absolute/path/to/existing.sqlite
```

Its output contains schema state and counts, not booking/customer/account contents. Inventory is not approval to migrate or clean up.

After separately authorized host quiescence and a verified current recoverable backup, the schema order for a legacy database is:

1. `migrate-booking-references.mjs --database ...`
2. Existing `migrate-notification-outbox.mjs --database ...`, if required for the release.
3. Exact schema, current owner/MFA, runtime and readiness verification before enabling service.

Both scripts run with `--conditions=react-server --experimental-strip-types`. Running the outbox script first with the new source refuses the missing label schema without changing data. Label migration and its preflight/postflight share an immediate transaction. Neither script restores an old snapshot, imports historical JSONL, enrolls an owner, sends notifications, or changes account/MFA settings.

Owner enrollment alone retains exact compatibility with either absent maps or the complete reviewed map schema. It still rejects partial/drifted maps, any trigger, and invalid existing core/account schemas. The invitation script and its delivery/retry behavior are unchanged.

## Rollback and deployment boundary

The earlier deployed/frozen fallback cannot accept new bookings after this feature because it does not allocate permanent references. A new rollback release must share the allocator, exact schema/readiness, projections and transactional vendor-code path. The separate reference-aware rollback source does this without importing the candidate's new UI.

The explicit cross-source test is:

```sh
node --conditions=react-server --experimental-strip-types tests/booking-reference-rollback.integration.mjs --fallback /absolute/path/to/reviewed/rollback/source
```

It creates only disposable synthetic data and tests candidate → rollback → candidate allocation, old-request replay, stable vendor renaming, outbox identity and preservation of current active-owner/MFA rows.

This source work does not update or authorize the frozen integration controller, migration-transition inspector, source profiles or host plans. Those currently describe the earlier outbox-only migration and must not be used unchanged to deploy this feature. A separately reviewed exact deployment route and new candidate/rollback runtime manifests are still required.

The historical fresh-start reset guard remains unchanged and refuses the new tables. Older reset scripts do not delete the new maps or `sqlite_sequence`, but no reset, deletion, cleanup or old-backup restore is authorized by this feature. The permanent sequence and mapping history must survive any separately approved future data operation.

## Customer access and visible labels

The sequential reference is display-only. Anonymous tracking and contact-only order access reject numeric references. Existing unpredictable tracking capabilities remain separate; newly generated links carry them in a fragment and the tracking page removes it after reading. Newly issued private identities include a fixed alphabetic marker before the same sixteen random hexadecimal characters, so even all-numeric entropy cannot collide with a sequential display label. Existing stored identities are never rewritten. A rare all-numeric historical capability is intentionally rejected rather than ambiguously interpreted. Booking creation retains an order-scoped session and the immediate handoff code, but self-entered contact details do not prove mailbox ownership. Only recovery-token redemption grants verified-contact privileges. Historical signed cookies without the mailbox-proof marker retain ordinary scoped access but lose those elevated privileges until recovery. Both candidate and reference-aware rollback use this rule; staff and personal-owner sessions are unchanged.

Customer confirmation, tracking, invoice headings, staff order labels, assignment/reconciliation worklists, provider-visible checkout fields, notification text and printed QR labels use the visible booking reference. Internal keys remain in relationships, request routing, signed QR claims, payment metadata and notification idempotency keys, never substituted with a sequential label. Existing unlabelled records display as legacy test bookings rather than leaking their internal identity as an ordinary heading. Linked activity events resolve the same authoritative display label on read, without changing saved event data. Ordinary overview and activity headings use this label; event identifiers remain available in explicit audit details, exports and routing, not as list subtitles.

No email or payment feature is enabled by this source change. Synthetic tests mock providers and prohibit external sending. Existing vendor records have no code until an explicitly reviewed inventory/mapping decision; no read-side backfill occurs.
