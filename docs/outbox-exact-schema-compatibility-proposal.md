# Exact outbox-schema readiness compatibility

Integrated into this local website candidate after independent review. This document retains the historical reproduction below; it is not deployment authorization. No live migration, publishing, deploying, external messaging, account changes or security changes were performed.

## Historical reproduced conflict

The earlier unmodified integrated `src/lib/data-store.ts` had SHA-256 `e252e8a9a6bf809f6a185b5df92a2ed782b537a5afde9cb06259749271e98fdc`. A synthetic database initialized through that file passes `databaseReadiness` before the first notification read and fails afterward.

The inherited migration adds eight columns and a lease index. SQLite updates the stored `sqlite_master.sql`, which no longer equals the legacy reference string. This is a compatibility conflict, not evidence of corruption. Two legacy outbox rows remained present: pending became `failed`/`manual_review`; sent remained `sent` and became `accepted`. Account and order sentinels were unchanged. That original review-only proposal left its source unchanged. This candidate now includes the reviewed exact compatibility check and shared migration helper; its final verification is recorded in the integration manifest.

## Integrated narrow change

1. Extract the existing ordered additive DDL into one helper. The runtime transaction, backfill and index creation retain their original sequence and semantics.
2. Keep `quick_check`, readability and every exact required comparison for all other tables/indexes.
3. Compare the complete outbox-owned `sqlite_master` object set, including its table, explicit/implicit indexes and any triggers, against exactly two in-memory references: the canonical legacy schema, or that schema with the known ordered additions and exact lease index.
4. Reject every other outbox schema. Readiness runs no migration DDL against the inspected database.

This is not a broad column allowlist, additive-subset check, SQL normalization or ignore-extra-columns rule. Extra outbox indexes/triggers are deliberately rejected. Unrelated optional tables remain allowed exactly as before; required non-outbox tables/indexes remain exact.

Read-only scope is explicit: the unchanged `/api/ready` path supplies an `openReadOnlyDatabase()` handle, and the tests verify that path and explicit read-only handles. The inherited no-argument `databaseReadiness()` default still invokes `getDatabase()`, which can initialize tables and purge expired location data before the readiness body runs. This proposal does not change that signature or claim the default is side-effect-free. Use the existing explicit read-only handle for probes.

## Exact additive contract

Append these definitions to the exact canonical legacy table, in this order:

| Column | Definition |
| --- | --- |
| delivery_state | TEXT NOT NULL DEFAULT 'queued' |
| lease_token | TEXT |
| lease_expires_at | TEXT |
| lease_attempt_started | INTEGER NOT NULL DEFAULT 0 |
| first_attempt_at | TEXT |
| provider_request | TEXT |
| provider_idempotency_key | TEXT |
| provider_account_hash | TEXT |

Keep the original primary key, dedupe uniqueness, channel/target/status checks, JSON check, defaults and `idx_notification_outbox_due(status, next_attempt_at)` unchanged. Add exactly `idx_notification_outbox_lease(delivery_state, lease_expires_at, next_attempt_at)`. No partial, reordered, otherwise equivalent-but-differently-written or unknown schema is accepted.

## Migration and review acceptance criteria

- Both exact variants pass. All 254 nonempty incomplete column subsets fail, including subsets that can already support a lease index.
- Missing/altered/extra outbox indexes, extra columns/triggers, wrong types/defaults/nullability and changed original constraints fail. Required non-outbox schemas retain their previous exact checks.
- Readiness through explicit read-only handles is read-only for accepted and rejected states: persistent database/WAL bytes, schema and row contents do not change. SQLite shared-memory reader-lock/read-mark metadata is excluded from file-byte assertions because a read-only reader can update that coordination metadata. Persistent database/WAL are not excluded.
- Runtime migration remains atomic. Injected backfill failure rolls back every added column and preserves every row. Successful retry preserves row IDs, dedupe keys, payloads, attempt counts, provider IDs, timestamps and unrelated account/order rows.
- Pending/failed legacy rows retain the inherited conservative `failed`/`manual_review` quarantine and explanation. Sent rows stay `sent`/`accepted`; skipped rows stay `skipped`/`skipped`. Provider acceptance is not delivery evidence. Row preservation does not mean status/error fields are byte-identical to their pre-quarantine values.
- Repeated initialization is idempotent. Readiness never sends or replays notifications.
- The actual readiness GET handler stays successful for anonymous, maintenance-token and authenticated-admin access after known additive DDL, without changing its synthetic database.
- Independent review and a separate explicit selection are required before including this proposal in any combined candidate or release payload. Existing preserving-deploy/approval gates are unchanged.

A passing result establishes existing integrity/readability checks and the two structural contracts only. It does not prove provider delivery, worker operation, notification credentials or a semantic backfill completed outside the application's atomic migration. The inherited runtime migration can still add missing columns when intentionally invoked; the read-only readiness probe itself rejects partial schemas and never repairs them.

## Rollout and rollback caveats, not solved by this proposal

- Old exact-readiness binaries still reject the migrated table. This proposal does not retroactively change an already retained release. A code-only rollback to such a build can therefore become unready after migration.
- Do not run old status-based notification workers concurrently with migration-aware workers. The prior baseline's `readDueNotifications` selects `status IN ('pending', 'failed')` with no `delivery_state` or lease condition. It can select quarantined `manual_review` rows and ignores the new lease ownership model. The compatibility guard does not prevent those old workers from doing so.
- Before any separately authorized rollout, independently verify a migration-aware rollback target and single compatible worker generation. An operational drain/cutover, rollback change, database restoration or schema downgrade is outside this proposal; none was performed or authorized by these tests. Do not restore/delete/replace a live database merely to satisfy an old readiness check.

## Verification

Node v22.23.4 with existing Next 16.4.2 dependencies; no package installation or heavy build.

- Proposal tests: 61/61 passing, including 254 incomplete subsets, injected migration rollback, row preservation, schema rejection and the real GET handler in three access modes.
- Existing read-only readiness and notification-outbox tests: 30/30 passing.
- Full project TypeScript `--noEmit --incremental false`: passing.
- Scoped ESLint for both production files and the new test: passing.
- Patch application and patched-file byte comparisons: passing.
- Integrated source SHA-256 unchanged; proposal helper absent from integrated source.

These focused checks are not a full application build/test run, production rehearsal or deployment. Those were intentionally not run.

Reproduce from the proposal checkout:

```sh
NODE="$(command -v node)"
$NODE --conditions=react-server --test --experimental-strip-types --experimental-loader=./tests/alias-loader.mjs tests/outbox-readiness-compatibility.test.mjs
$NODE --conditions=react-server --test --experimental-strip-types --experimental-loader=./tests/alias-loader.mjs tests/readiness-readonly.test.mjs tests/notification-outbox.integration.mjs
$NODE node_modules/typescript/bin/tsc --noEmit --incremental false
$NODE node_modules/eslint/bin/eslint.js src/lib/data-store.ts src/lib/notification-outbox-schema.ts tests/outbox-readiness-compatibility.test.mjs
```

The review patch contains only the data-store modification, shared helper, compatibility tests and this rationale. Logs and the unmodified reproduction fixture are included separately in the review archive.

The helper caches completion only after it owns and commits the outermost transaction. Caller-owned savepoints are not cached, so an enclosing rollback cannot leave a false migrated state. Commit and rollback regressions cover this behavior.
