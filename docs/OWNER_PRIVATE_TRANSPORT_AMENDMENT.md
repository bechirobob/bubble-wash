# Dedicated owner invitation transport (local preparation only)

The owner workflow reads the protected environment secret BUBBLEWASH_OWNER_RESEND_KEY and streams it with the already-private recipient through encrypted SSH stdin. It is passed only in memory to the short-lived enrollment process. It is never a workflow input, command-line argument, temporary file, application environment-file setting, artifact, or diagnostic value. Shared RESEND_API_KEY and BUBBLEWASH_EMAIL_FROM are excluded from that child environment. There is no fallback to application or Tickets credentials.

The invitation script fixes the proposed sender to exactly `Bubble Wash <bubblewash@becoreops.com>`. It cannot select arbitrary addresses on that domain. This source amendment does not authorize or perform credential creation, secret installation, sender approval, account creation, or email delivery. Those remain separate gates. The existing explicit delivery attestation, backup/source/release pins, personal MFA checks, collision checks, and no-retry-on-uncertain-delivery behavior are unchanged.

The shared-application transport inspection labels its scope and explicitly does not inspect the private owner secret. The enrollment check labels private-owner-only transport and separately reports only a boolean for the shared application transport. A missing dedicated secret blocks enrollment even if the shared provider key is configured.

When NODE_ENV is omitted from the application environment file, enrollment accepts only read-only evidence of the exact active service, expected environment-file/current-release directories, unique Node listener in the same service cgroup, stable main/listener identities, and an explicitly production listener. All other authentication flags must match both processes and the parsed file. A conflicting explicit NODE_ENV, main-process conflict, missing evidence, or drift fails closed. No environment file is changed. Existing missing-schema checks remain fail closed; no initializer is added.

Tests are synthetic. No live credential, recipient, token, or email was used. Provider/domain setup and delivery authorization remain pending.
