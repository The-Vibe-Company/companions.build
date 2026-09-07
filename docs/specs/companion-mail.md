# Companion email

Approved September 7, 2026. Resend carries incoming and outgoing mail; PostgreSQL owns
mail identities, drafts, permissions, scheduling, quota and delivery state.

## Product contract

- An account chooses a unique permanent alias. Each permanent Companion chooses a local
  name and gets `account.companion@mail.companions.build`. Retirement never releases an address.
- The account email and explicitly allowed senders may start work. Replies to an owner-approved
  outgoing message are allowed within its thread. Other incoming mail is ignored without a reply.
- Incoming work has a separate task and thread context. It cannot change product permissions,
  inspect unrelated histories, create agents or delegate work. Replies stay within the incoming
  thread and target its sender; contacting additional recipients needs the owner.
- Preparing a mail creates a persisted draft with an HTML preview, recipient list and attachments.
  An explicit instruction to send authorizes that individual message. Permanent permissions require
  a separate explicit instruction. React Email renders the same HTML used by preview and sending.
- Each account has 50 recipient units per UTC day, shared by all Companions and including replies.
  To/Cc/Bcc addresses count once per distinct recipient. Receiving does not consume this application
  quota. Resend's own account limits are separate.
- The quota is reserved transactionally before sending. At the limit, the message becomes
  `quota_exceeded`; resetting the counter never requeues it. The owner can explicitly schedule it
  or create a one-shot reminder. Scheduled sends recheck quota at execution.
- One-shot routines accept an ISO `runAt`, execute once, disappear from active routines after
  success and retain activity/history. Failed executions remain visible. Recurring routines retain
  their existing behavior.
- Up to five attachments with a combined 10 MB limit are supported. Incoming files are staged in
  the task's Linux workspace; existing retained output files can be attached by identifier.

## Execution and trust

The API validates the raw-body Resend webhook signature and persists reception before responding.
Only the executor retrieves incoming content, admits mail tasks and sends approved mail. Provider
requests carry stable message identities; a lost send response is `ambiguous`, never automatically
resent. Signed provider events can reconcile that state. Quota reservations remain consumed after
an uncertain attempt, so uncertainty cannot create extra sends.

The original incoming MIME message must have a valid, full-body DKIM signature aligned exactly
with its From domain. The verified From address must match the provider's sender. Unauthenticated
mail never starts work; sender-provided authentication-result headers are not trusted. This first
version does not admit SPF-only messages or messages whose forwarding invalidates DKIM.

Allowed senders operate within the Companion's existing computer and selected integrations.
Product control permissions are enforced by the server; this is not a separate computer sandbox
for each correspondent. Owners should authorize correspondents for that Companion's mission.

## Hosting

1. Add `mail.companions.build` to Resend with sending and receiving enabled. Publish the exact
   DKIM, sending SPF/MX and receiving MX records returned by Resend. Do not replace root-domain MX.
2. Set `RESEND_API_KEY` on API and executor, and `COMPANION_MAIL_DOMAIN` consistently on both.
   The existing authentication-mail sender remains configured through `EMAIL_FROM`.
3. After the API route is deployed, register `https://companions.build/api/webhooks/resend` for
   `email.received` and `email.sent`; store its signing secret as `RESEND_WEBHOOK_SECRET` on the API.
4. Apply migrations and build the agent distribution before deploying. Roll out the new runtime
   with the mail control operations; no dependency installation happens when an agent wakes.

Domain and all four DNS records were verified by Resend during implementation. No real recipient was sent mail
as part of local validation. Production webhook activation and an authenticated delivery canary
belong to deployment verification.

References: [Resend receiving](https://resend.com/docs/dashboard/receiving/introduction),
[retrieving original mail](https://resend.com/docs/api-reference/emails/retrieve-received-email),
[React Email rendering](https://react.email/docs/utilities/render).
