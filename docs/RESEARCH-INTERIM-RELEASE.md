# Temporary native survey release candidate — not activated

## Content and approved routing

Native temporary public /survey with four separate questionnaires, no login, staff portal or permanent navigation item. An adult eligibility gate precedes personal information. Name/email/phone and organisation for business/vendor precede questions. Under-18 and refused-consent responses are rejected before storage or email.

The respondent payload contains all 69 consumer questions, 17 consumer-interview questions plus all four profile probes, 12 B2B and 13 vendor questions. Questions/options and order follow the updated five-DOCX pack (ZIP SHA256 500f71f85c7e37f89d0f459c7ab2f4766b928bcebc9c320dd4c1b76ca0c4f5ea). Income bands, university options, standard-bag wording and the explicit H2 no-incentive wording are restored. No numbered question is omitted and no placeholder or release-status label is shown to respondents.

Sequential Yes/No eligibility questions follow the setup predicates and route every matching module/probe. Short labels remain Students, Business owners, Office workers and Households. Students must attend university/college and live in hall/hostel/shared accommodation; business owners includes self-employment; office workers requires office/corporate employment; Households requires women who work and have household laundry responsibilities. The explicit A4 business/office answers qualify F2/F3 without asking a duplicate eligibility question; otherwise sequential checks include qualifying overlaps. Changing A4 restores any newly needed eligibility check. Overlapping respondents count once overall. Eligibility is validated server-side and changing it removes no-longer-applicable answers.

A3 Other requests clarification and is flagged for analysis review; None of these remains outside agreed area quotas. Exact named areas are retained without invented quota clustering. A4 Other requires the supplied work/study clarification. University Other requires specification. The owner-directed interpretation retains A2 Neither adult responses, flags them outside the Accra sample/core analysis, and continues common questions. No partial screening submission or extra email is created. Derived analysis flags cannot be supplied or overridden by the browser. Distribution-channel reference mapping remains unspecified.

Consumer source explicitly permits skipping optional questions and labels C3, D3 and H optional; other consumer research requiredness is unspecified. Do not invent mandatory research answers. Interview source permits skipping any question. Original interviewer recording/site-observation instructions are preserved in canonical evidence but cannot truthfully describe this self-completed form. No call recording, on-site inspection or media upload is implemented or claimed. Vendor Q6 retains its original price-list/photo-with-permission wording. Distribution reference configuration remains pending, without invented channel values.

## Privacy, delivery and closure

The short notice truthfully discloses identified details and answers stored by Bubble Wash and emailed in full to info@bubblewash.co for research; responses are not anonymous. Existing privacy-request and email contact routes remain accessible in More information. Required contact details do not opt respondents into future contact. The approved updated policy retains identifiable website responses for up to 12 months from collection, then reviews deletion or anonymisation subject to a lawful retention obligation or justified research need. No automatic permanent deletion or cleanup of the recipient's email copies is promised or scheduled. The supplied legal entity is Bubble Wash Technologies Ltd., Eugene’s Place, Accra, Ghana; privacy contact is info@bubblewash.co.

Fixed sender Bubble Wash <bubblewash@becoreops.com>, fixed recipient info@bubblewash.co, dedicated BUBBLEWASH_RESEARCH_RESEND_KEY only. The separately scoped credential lane handles installation; no owner-only credential fallback. This candidate has not read credentials or sent a real email.

Save the validated response and outbox atomically before dispatch. Stable idempotency keys, bounded payload/streaming timeout/admission budget, atomic leases, fresh-clock checks and checked updates remain. At most five attempts; retry only definitive throttling. Timeout/provider5xx/409 or expired uncertain claims require operator reconciliation, not blind resending. Provider acceptance is not inbox delivery proof. No public response view or general customer email capability.

The trusted server-only synthetic helper constructs one fixed marked payload, saves and claims it once, sends To info@bubblewash.co and copies the protected owner-email setting only for this operation. The owner address is not hard-coded, logged or accepted from a public client. Prior/uncertain attempts cannot resend. No real test has been consumed. Invoke only after actual deployed schema/key/runtime readiness through the approved operator procedure, without printing secrets or putting them in command arguments.

Manual close uses BUBBLEWASH_RESEARCH_OPEN=false. Optional expiry fails closed when invalid or expired. Closing rejects new responses without deleting records.

## Release gates

Current main ancestry includes the reviewed PR69 HOME transport correction at6c48f0cf. Preserve all maintenance controls and historical/fallback identities; refresh only candidate source/enrollment/compatibility pins. Run full exact-head build/tests and hosted Chromium/WebKit/mobile/desktop acceptance after final integration. Local browser socket creation is unavailable and is not retried or weakened.

Collection and delivery policy flags remain false until actual host prerequisites pass. Before activation: approved host/source sequencing, protected backup, additive two-table survey migration and schema verification, dedicated-key installation, truthful notice/retention configuration, deployed request-size/read-time/distributed-throttle checks, and the single marked synthetic end-to-end email. No DDL, host change or real collection is performed by source preparation. Enable environment flags last. No existing records are removed.

The isolated hosted fixture uses temporary synthetic storage and synthetic credentials with external egress blocked. It enables flags only in its disposable checkout; its built artifact is not a deployment artifact. Passing fixture checks do not prove real host or provider delivery readiness.
