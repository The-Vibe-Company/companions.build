# Billing and client delivery

## Email delivery

Magic-link sign-in and client invitations share one mail transport. Local development keeps using
Mailpit through the launcher-provided `SMTP_HOST`, `SMTP_PORT`, and `SMTP_FROM` values. A hosted
Resend deployment must explicitly set `EMAIL_PROVIDER=resend`, `EMAIL_FROM` to an address on a
verified sending domain, and the secret `RESEND_API_KEY`. Hosted SMTP can instead set
`EMAIL_PROVIDER=smtp` together with the existing `SMTP_*` variables; `EMAIL_FROM` overrides
`SMTP_FROM` when both are present. Setting a Resend key without selecting the Resend provider does
not enable it.

Provider calls have a bounded timeout and expose only stable error codes. Delivery invitations
retain their durable claim-before-send behavior: an ambiguous provider result is recorded as
`unknown` and is never retried blindly.

The hosted product uses a companions.build Stripe subscription and a durable internal usage ledger. Users never provide Box or model-provider payment credentials.

## Configuration and routes

Hosted billing requires `STRIPE_SECRET_KEY`, a fixed recurring `STRIPE_BASE_PRICE_ID`, distinct recurring metered `STRIPE_MODEL_PRICE_ID` and `STRIPE_BOX_PRICE_ID` values, `STRIPE_WEBHOOK_SECRET`, `STRIPE_METER_EVENT_NAME`, `STRIPE_BOX_METER_EVENT_NAME`, and `APP_URL`. Model tokens and elapsed Box seconds use separate Stripe meters. All three Price IDs must be distinct. Missing or duplicate Price configuration produces an explicit unavailable state and never projects an active plan. `BILLING_TEST_MODE=1` is accepted only outside production; it permits local delivery activation and returns a deterministic local Checkout destination without creating a subscription.

- `GET /api/billing` returns configuration mode, subscription status, activation state, and owner-scoped usage totals.
- `POST /api/billing/checkout` creates a Stripe-hosted subscription Checkout Session.
- `POST /api/billing/portal` creates a short-lived customer portal session for the authenticated account's Stripe customer.
- `POST /api/stripe/webhook` is public but accepts only a fresh, valid Stripe signature over the untouched request body. Stripe event IDs are committed with account changes to deduplicate retries.

`recordUsage({operationId, ownerId, companionId?, category, quantity, unit, occurredAt?, metadata?})` commits an immutable ledger row before attempting Stripe delivery. The accepted pairs are `model_tokens`/`token`, `box_seconds`/`second`, and the non-metered `box_lifecycle`/`event` audit category. `(ownerId, operationId)` deduplicates retries only when all billing data matches; a changed replay is rejected. Metadata is bounded and rejects credential-like keys or values. `flushPendingUsage(ownerId)` retries rows recorded before the account had a Stripe customer. Runtime failures must not be caused by temporary Stripe delivery failures.

Stripe Checkout uses subscription mode with the fixed base Price at quantity one and both metered Prices as separate line items; metered line items do not set a fixed quantity. The server stores the complete unique Price set for each Subscription received through signed events and separately tracks the Subscription selected by Checkout. Only that selected Subscription with exactly all three configured Prices grants access. A missing, duplicate, additional, or different Price fails closed. Existing two-Price fingerprints do not gain entitlement after this configuration change; a later signed Subscription event carrying the exact configured three-Price set must update them. Events for another Subscription cannot overwrite the selection, and out-of-order events cannot roll its status backward. Stripe's customer portal remains the payment and cancellation surface.

## Client delivery

`POST /api/deliveries` requires a stable `clientDeliveryId` UUID and creates an invitation for a lower-cased client email and an owned Companion. The web client keeps that UUID across ambiguous retries. Reusing it with the same request returns the first invitation without another email; reusing it with changed details is rejected. The persisted profile snapshot contains name, instructions, avatar, selected model (`null` retains the deployment default), and explicitly selected agent-template profiles. In parallel, explicitly included bounded local Pi skills are exported into validated immutable private bundles for the delivered Companion and selected templates. Private template snapshots, source references, personal connections, OAuth tokens, browser sessions, machine identifiers, secrets, and transcripts are excluded.

The recipient signs in through Better Auth and must have the exact verified email before `POST /api/deliveries/:id/accept` succeeds. Activation requires an active subscription whenever Stripe billing is configured. Acceptance creates a new Companion identity and a fresh Box from the configured base template. Portable child templates receive new IDs and preserve their declarative profile, bounded child permission, and validated portable-skill bundle.

Maintenance is a separate explicit grant. The sender may request it, but access exists only when the recipient accepts with `grantMaintenance: true`. The recipient can revoke it through `DELETE /api/deliveries/:id/maintenance`. `canMaintainCompanion` is the only maintenance authorization helper; ownership never follows from the original delivery.

## Stripe sources

- [Set up a flat fee and overages pricing model](https://docs.stripe.com/billing/subscriptions/usage-based-v1/use-cases/flat-fee-and-overages) documents combining a fixed recurring Price with a usage-based Price on one Subscription.
- [Build a subscriptions integration](https://docs.stripe.com/billing/subscriptions/build-subscriptions) documents subscription-mode Checkout, storing Customer and Subscription IDs from events, and creating portal sessions on demand.
- [Stripe webhook delivery](https://docs.stripe.com/webhooks?lang=node) requires the raw request body, describes the five-minute signature tolerance, duplicate delivery, retries, and unordered events.
- [Stripe signature troubleshooting](https://docs.stripe.com/webhooks/signature) documents the `Stripe-Signature` timestamp and `v1` signature format.
- [Record usage with the Meter Events API](https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api) documents whole-number quantities, unique identifiers, timestamps, and asynchronous meter processing.

## Runtime metering

The worker records terminal Pi usage once per shared response root, including failed and
interrupted tasks for which Pi reported usage. Native steering does not multiply the count.
Box time is measured between confirmed `ready` and `archived` lifecycle events, in seconds;
completed minutes are checkpointed during operation and the final partial minute after archive.
Provisioning time before confirmed readiness is not charged by this ledger.

`STRIPE_METER_EVENT_NAME` is the model-token meter. `STRIPE_BOX_METER_EVENT_NAME` is a separate
Box-second meter: different units are never added into one meter. Internal `box_lifecycle`
events are audit records and are never sent as billable consumption. Both meter names are required
for Stripe mode. If either is absent, billing is unconfigured and cannot grant hosted activation;
ledger rows recorded outside Stripe mode are marked skipped rather than queued for provider
delivery. `STRIPE_MODEL_PRICE_ID` must name the recurring metered Price attached to the model-token
meter, and `STRIPE_BOX_PRICE_ID` the distinct recurring metered Price attached to the Box-second
meter. `STRIPE_BASE_PRICE_ID` must name the fixed recurring subscription Price. Configure all three
Prices with the same compatible billing currency and interval. The
application cannot infer commercial rates or create Prices without that configuration.
