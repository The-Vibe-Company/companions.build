# Webhook triggers

Triggers turn authenticated external events into durable background work without contacting a model or waking a Companion during receipt. They support a generic signed endpoint, GitHub failed workflow runs on a configured branch, and Sentry project service hooks. Every definition, provider connection lookup, delivery, and batch is scoped through the immutable Companion owner.

## API and integration order

Call `migrateTriggers()` after the accounts, plugins, and automation migrations. In the HTTP server, call `handleWebhook(request)` before Better Auth for `/api/webhooks/:triggerId`; the route authenticates the sender itself. Call `handleTriggers(request, ownerId)` only after Better Auth.

Authenticated routes are:

- `GET|POST /api/companions/:companionId/triggers`
- `PATCH|DELETE /api/companions/:companionId/triggers/:triggerId`
- `POST /api/companions/:companionId/triggers/:triggerId/test`
- `POST /api/companions/:companionId/triggers/:triggerId/register`
- `GET /api/companions/:companionId/triggers/:triggerId/deliveries`

A trigger draft contains `name`, `prompt`, `source` (`generic`, `github`, or `sentry`), `mode` (`direct` or `filter`), optional `filter` (the `filterCode` alias is also accepted), up to five `filterRequests`, optional `problemPath`, optional `providerAccountId`, provider `target`, and `enabled`. GitHub targets require `repo`, accept `branch` (default `main`) and normally use `events: ["workflow_run"]`. Sentry targets require `organization` and `project` and normally use `events: ["event.created"]`.

Public projections include registration state and the webhook URL but never a signing secret or provider credential. Generic creation returns its signing secret exactly once. Generic senders use either `Authorization: Bearer <secret>` or `X-Companions-Signature: sha256=<HMAC-SHA256(raw body)>`. GitHub uses `X-Hub-Signature-256`; Sentry uses `Sentry-Hook-Signature`. Comparisons are constant-time and happen on the raw bounded body before JSON parsing.

GitHub and Sentry definitions immediately reconcile a remote hook through the selected owner connection. GitHub updates an existing URL so the local and remote HMAC secret cannot drift. Sentry adopts the secret returned by its service-hook API. A missing, ambiguous, expired, or unreadable OAuth connection yields `registrationStatus: "needs_connection"`; the product does not claim registration succeeded. Deleting a managed trigger first deletes the exact remote hook and keeps the local row when provider cleanup is uncertain.

The adapters follow the provider contracts for [GitHub repository webhooks](https://docs.github.com/en/rest/repos/webhooks), [GitHub delivery validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), and [Sentry project service hooks](https://docs.sentry.io/api/projects/register-a-new-service-hook/).

## Durable receipt and grouping

`handleWebhook()` only verifies, parses, and inserts `trigger_deliveries`, returning `202`. It never calls the filter, provider APIs, background enqueue callback, model, Pi, or Box. Strict redeliveries use a provider delivery identifier when present and otherwise a payload digest. Reusing an identifier with different content returns a conflict.

The worker calls `processTriggerInbox({ enqueueBackground })`. It reclaims a stale evaluation lease, resolves declared provider reads, runs the filter, and persists the decision. A false or failed filter never invokes `enqueueBackground`. The callback contract matches the automation module:

```ts
({ companionId, clientMessageId, content, source: "trigger" }) => Promise<string | null>
```

The batch UUID is the stable `clientMessageId`, so retries cannot create duplicate runs. `triggerBatchContext(runId)` returns the accepted event payloads for dispatch-time context. The executor must load this projection immediately before a trigger run starts; this lets later events enrich a still-queued batch without rewriting a run already being dispatched.

`problemPath` is a bounded dot path to a scalar event identity. Sentry defaults to `data.issue.id`; GitHub defaults to `workflow_run.id`; otherwise the payload digest keeps distinct problems separate. Distinct accepted events join an existing queued batch. Once its run is active, at most one queued follow-up batch is created. `processTriggerInbox()` calls `syncTriggerBatches()` against durable run state before grouping.

## Code filters and provider reads

A filter defines one synchronous function:

```js
function shouldTrigger(payload, responses) {
  return payload.action === "completed"
    && responses.issue.state === "open";
}
```

It must return the boolean `true` to accept. Filter code never runs in the API process or on the host. `packages/filters` sends only JSON through stdin to a digest-pinned Node Linux container with no network, no host mount, a read-only filesystem, no capabilities, `no-new-privileges`, an unprivileged user, PID/memory/CPU limits, a VM code-generation ban, a 50 ms script limit, and a two-second host kill. Run `python3 scripts/filter-build.py` during build or deployment so runtime never pulls an image while processing an event.

Optional API consultation is declarative. Each `filterRequests` entry specifies a response `key`, an authorized `provider`, optional exact `connectionId`, and a relative GET `path`. GitHub paths are pinned under `https://api.github.com/repos/`; Sentry paths are pinned under `https://sentry.io/api/0/`. The worker validates the origin, resolves only the owner's OAuth connection, fetches with a timeout and response limit, parses JSON, then supplies the values as `responses`. Credentials, arbitrary URLs, headers, redirects, and network access never enter the filter container.
