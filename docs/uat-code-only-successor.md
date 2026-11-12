# Code-only UAT successor

Prepared controls only. No host execution or deployment has occurred.

- Previous application: `8bd37b028b550967f9a3eefcd60a52cbcb4f2da9`.
- Application candidate: `e3eda2a57fcb542ea78a103a8aee8d0a2573fa96`, tree `0085fdaece59368e2bd60845245e3325fc3042ae`.
- Changes only the existing isolated UAT application. No production service, routing, account issuance, credential reset, schema change or extension issuance.
- Each active account must have a valid credential-bound grant ending at the existing approved expiry, `1795062608095` milliseconds UTC. Original issuance dates remain unchanged.
- Uses new staging and journal under `/opt/bubblewash-uat/code-update-20261112`. Historical recovery folders and journals remain untouched. Retains the existing shared update lock.
- Saves a protected snapshot while stopped; compares all schema, account, extension and business records before and after. As in the existing updater, ephemeral driver GPS readings are excluded because startup removes expired readings.
- Exchanges application directories atomically, retaining the current extension-aware code as the rollback copy. No automatic rollback, database restore or retry. Never use the older pre-extension application as rollback.

## Before dispatch

Merge reviewed controls and refresh only their exact runner-source commitment. Require successful release checks for controls and the fixed candidate. Use `uat-code-update.yml` from exact main, first attempt only, with approved interruption and a coordinated quiet window. The workflow builds the fixed candidate with Node22, then restores the exact controls revision before transport. Attestations record existing permission, not grant it.

Any missing, failed or uncertain receipt requires read-only inspection before further action. Do not replay stopped-update recovery, remove an operation journal, change existing pins or retry with another operation ID.

## Local checks

`python3 -B -m unittest discover -s ops/uat/update -p 'test_*.py' -v`

All fixtures are synthetic and no test contacts the host or sends provider traffic. Hosted acceptance is still required after a separately authorized release.
