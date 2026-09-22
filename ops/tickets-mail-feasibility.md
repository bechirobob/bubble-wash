# Tickets VPS email feasibility — 22 September 2026

Read-only inspection completed in [run 35723581359](https://github.com/bechirobob/bubble-wash/actions/runs/35723581359), source a15b26de1f4d11de711c6d6e9f376a91d7569aa8. This operational branch uses the existing Hermes Tailscale connection; it does not change or deploy Bubble Wash or Tickets. No mail was sent and no VPS services, credentials or DNS records were changed.

## Verified

- Outbound TCP port 25, SMTP greeting/EHLO and certificate-validated STARTTLS succeeded from Hermes to the published Gmail, Outlook and Yahoo mail exchangers.
- An existing Node SMTP relay listens on port 587. Its active source resolves recipient MX records directly, and appears to belong to an older, unrelated domain. Existing service credentials and sender configuration were not read.
- The VPS PTR points to an unrelated mail hostname whose forward DNS lookup returns NXDOMAIN. mail.becoreops.com also returns NXDOMAIN.
- Root SPF and DMARC records exist for existing providers. No Tickets VPS sender authorization or DKIM signature was verified.
- No inbox delivery or sender-IP reputation conclusion can be drawn from SMTP/TLS connectivity alone.

## Assessment and next action

Direct transactional sending from the existing VPS is technically feasible, with no need to relay through Resend. A working production replacement is not configured. Before switching: establish a dedicated Tickets sending hostname, fix provider-managed PTR and matching forward DNS, configure SPF/DKIM/DMARC, and run controlled inbox-delivery checks. Google requires valid matching forward/reverse DNS and authenticated TLS delivery: https://support.google.com/mail/answer/81126.

Keep promotional campaigns on the current Resend Broadcasts route. Preserve the other domain's SMTP services; isolate Tickets credentials, queue, retries, duplicate protection, bounce handling and access controls. A VPS relay that still calls Resend would retain Resend quotas. Reusing the existing host can avoid another email-provider subscription, but delivery acceptance and server capacity remain to be verified before migration.
