# Billing and client delivery

The hosted product uses a companions.build Stripe subscription and a durable internal usage ledger. Users never provide Box or model-provider payment credentials.

## Configuration and routes

Hosted billing requires `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_METER_EVENT_NAME`, and `APP_URL`. Missing configuration produces an explicit unavailable state. It never projects an active plan. `BILLING_TEST_MODE=1` is accepted only outside production; it permits local delivery activation and returns a deterministic local Checkout destination without creating a subscription.

- `GET /api/billing` returns configuration mode, subscription status, activation state, and owner-scoped usage totals.
- `POST /api/billing/checkout` creates a Stripe-hosted subscription Checkout Session.
- `POST /api/billing/portal` creates a short-lived customer portal session for the authenticated account's Stripe customer.
- `POST /api/stripe/webhook` is public but accepts only a fresh, valid Stripe signature over the untouched request body. Stripe event IDs are committed with account changes to deduplicate retries.

`recordUsage({operationId, ownerId, companionId?, category, quantity, unit, occurredAt?, metadata?})` commits an immutable ledger row before attempting Stripe delivery. `(ownerId, operationId)` deduplicates retries. Metadata is bounded and rejects credential-like keys or values. `flushPendingUsage(ownerId)` retries rows recorded before the account had a Stripe customer. Runtime failures must not be caused by temporary Stripe delivery failures.

Stripe Checkout uses subscription mode and the configured Price ID. The server stores Customer and Subscription IDs received through signed events. Subscription events are applied by Stripe creation time, so out-of-order events cannot roll status backward. Stripe's customer portal remains the payment and cancellation surface.

## Client delivery

`POST /api/deliveries` creates an invitation for a lower-cased client email and an owned Companion. Only the portable profile is captured: name, instructions, avatar, and explicitly selected agent-template profiles. Private template snapshots, source references, personal connections, OAuth tokens, browser sessions, machine identifiers, secrets, and transcripts are excluded.

The recipient signs in through Better Auth and must have the exact verified email before `POST /api/deliveries/:id/accept` succeeds. Activation requires an active subscription whenever Stripe billing is configured. Acceptance creates a new Companion identity and a fresh Box from the configured base template. Portable child templates receive new IDs and preserve only their declarative profile and bounded child permission.

Maintenance is a separate explicit grant. The sender may request it, but access exists only when the recipient accepts with `grantMaintenance: true`. The recipient can revoke it through `DELETE /api/deliveries/:id/maintenance`. `canMaintainCompanion` is the only maintenance authorization helper; ownership never follows from the original delivery.

## Stripe sources

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
events are audit records and are never sent as billable consumption. A missing Box meter
leaves its usage pending. Configure the corresponding usage prices on the Stripe subscription;
the application cannot infer commercial rates or create prices without that configuration.
