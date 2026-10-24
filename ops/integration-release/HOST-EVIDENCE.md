# Protected rehearsal and plan handoff

The release coordinates the three known Bubble Wash units under the existing deployment lock and persistent holds. It does not technically exclude privileged root, ubuntu, other operators or unknown invokers. Those operators must not write the database or launch Bubble Wash during the approved window. The explicit residual-risk approval is required; a global-exclusion assertion is not accepted.

The known units are system/bubblewash-maintenance.timer, system/bubblewash-maintenance.service and user/bubblewash-local.service. Their current sources, properties and control groups are observed under the lock. A blank cgroup is acceptable only when observed inactive/dead with no process IDs. Before migration all known units must be stopped, observed groups empty, captured processes absent and port 3000 unused. Conditions gate future starts; they do not stop existing writers.

## Preparation

The protected control package is /var/lib/bubblewash-release/packages/<packageId>. Its identity is the SHA-256 of canonical JSON containing adapterFiles and sourceContractSha256. It is separate from the exact immutable runtime sources. The accepted candidate is 5f256800d65dbe3b69f54e95afa0e8ab30b5e881; the fallback is 80ec00902fcc5fe16a17ab814c7d191ad44afb64. The live source before this upgrade is 853b7c1020fb7dab66f302a2603369d5fa8b3dff.

Preparation stages fresh build and production-only runtime workspaces, freezes them into root-owned releases, and rehearses both against separate copies of one retained private SQLite preimage. It does not create maintenance holds, restart services, switch production code or write the live database. A failed or interrupted attempt is retained for inspection, not reused automatically.

Only a successfully completed protected rehearsal evidence file may be materialized. Its source contract, whole source trees, runtime/dependency manifests and unchanged preimage are checked again. The preimage is not the later maintenance snapshot and must never be restored over live data.

## Materialization request

The exact request keys are packageId, preparationRunId, preparationEvidenceSha256, ownerEvidenceSha256, operatorApprovalSha256, riskApprovalSha256, gitBindings, backup and reviewRecords. All digests are lowercase SHA-256. The runner derives gitBindings from the actual clean candidate/fallback checkouts, never from user input. backup contains sha256, receiptRun, storeSha and storeId for a fresh, verified encrypted backup.

reviewRecords contains owner and operator records. The owner record uses schema bubblewash-owner-pair-review/v1 and binds candidateSha, fallbackSha, ownerFiles, ownerCapabilityPreserved, MFAPreserved, enrollmentCompatible and reviewReference. All three preservation flags must be true. The operator record uses schema bubblewash-operator-approval/v1 and binds candidateSha, fallbackSha, riskApprovalSha256, residualAssumptionSha256, approved and reviewReference. Approval must be true and refer to actual reviewed authorization. Record digests bind real evidence; they do not create authority. Never fabricate review records from tests.

Under the retained lock, the host rechecks current source, process, Node executable, environment, database inode, backup and known-unit evidence. It creates a bounded host/boot operator receipt with a maximum 30-minute validity, the exact source contract, known inventory and residual-risk approval. It exclusively writes root0600 review records within a new root0700 /var/lib/bubblewash-release/plans/<packageId> directory, then validates and writes /var/lib/bubblewash-release/plans/<packageId>.json. The imported code package remains byte-identical. Output contains only status and the final plan digest.

Materialization never opens live SQLite or stops services. Existing plan, review directory, maintenance snapshot or transition journal causes refusal. A partial write is preserved for investigation. Do not overwrite it, automatically renew an expired receipt, or replace journal identity after a crash.

## Execution and recovery

The approved live upgrade still requires successful private-copy rehearsal, valid fresh evidence and all final checks. Existing accounts, owner/MFA access, responses, bookings and booking pause remain intact. No PHP, native-app release, WhatsApp commercial enablement or unrelated security change is authorized here.

Persistent holds and the current-data compatible fallback protect interrupted execution. An expired host receipt or changed evidence fails closed. Recovery after expiry requires explicit evidence review while preserving the original package and durable transition identity. Never restart an incompatible historical app or restore a stale snapshot after the new app could have served requests.
