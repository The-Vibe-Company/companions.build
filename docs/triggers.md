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

Public projections include registration state and the webhook URL but never a signing secret or provider credential. Generic creation returns its signing secret exactly once. Generic senders use either `Authorization: Bearer <secret>` or `X-Companions-Signature: sha256=<HMAC-SHA256(raw body)>`. GitHub uses `X-Hub-Signature-256`; Sentry uses `X-ServiceHook-Signature`. Comparisons are constant-time and happen on the raw bounded body before JSON parsing.

GitHub and Sentry definitions immediately reconcile a remote hook through the selected owner connection. GitHub updates an existing URL so the local and remote HMAC secret cannot drift. Sentry adopts the secret returned by its service-hook API. A missing, ambiguous, expired, or unreadable OAuth connection yields `registrationStatus: "needs_connection"`; the product does not claim registration succeeded. Deleting a managed trigger first deletes the exact remote hook and keeps the local row when provider cleanup is uncertain.

The adapters follow the provider contracts for [GitHub repository webhooks](https://docs.github.com/en/rest/repos/webhooks), [GitHub delivery validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), and [Sentry project service hooks](https://docs.sentry.io/api/projects/register-a-new-service-hook/).

## Durable receipt and grouping

`handleWebhook()` only verifies, parses, and inserts `trigger_deliveries`, returning `202`. It never calls the filter, provider APIs, background enqueue callback, model, Pi, or Box. Strict redeliveries use a provider delivery identifier when present and otherwise a payload digest. Reusing an identifier with different content returns a conflict.

The worker calls `processTriggerInbox({ enqueueBackground })`. It reclaims a stale evaluation lease, resolves declared provider reads, runs the filter, and persists the decision. Every decision checks the captured evaluation attempt; a suspended predecessor cannot ignore, accept again, or fail a delivery already reclaimed by another worker. A false or failed filter never invokes `enqueueBackground`. The callback contract matches the automation module:

```ts
({ companionId, clientMessageId, content, source: "trigger" }, transaction: Database) => Promise<string | null>
```

Production passes `enqueueBackgroundInTransaction`. The callback must use the supplied PostgreSQL transaction: the queued run and its batch link commit together, so dispatch cannot observe a run without its payload context. A failed link checkpoint rolls back admission; retries retain the same batch identity.

The batch UUID is the stable `clientMessageId`, so retries cannot create duplicate runs. `triggerBatchContext(runId)` returns the accepted event payloads for dispatch-time context. The executor must load this projection immediately before a trigger run starts; this lets later events enrich a still-queued batch without rewriting a run already being dispatched.

`problemPath` is a bounded dot path to a scalar event identity. Sentry defaults to `group.id`; GitHub defaults to `workflow_run.id`; otherwise the payload digest keeps distinct problems separate. Distinct accepted events join an existing queued batch. Once its run is active, at most one queued follow-up batch is created. `processTriggerInbox()` refreshes batch projections, then locks and checks the actual run again inside the grouping transaction after asynchronous filtering. Once admission has begun, later events create a follow-up instead of changing the context already staged for that run.

## Code filters and provider reads

A filter defines one synchronous function:

```js
function shouldTrigger(payload, responses) {
  return payload.action === "completed"
    && responses.issue.state === "open";
}
```

It must return a boolean; only the exact value `true` accepts. `packages/filters` evaluates the
function in a fresh QuickJS WebAssembly runtime with a 50 ms interrupt deadline, a 16 MiB guest
heap, and a 512 KiB guest stack. Payloads and predefined provider responses cross the boundary as
bounded JSON, are parsed and recursively frozen inside the guest, and no host function, module
loader, filesystem, network, environment, or import capability is installed. Every context and
runtime is disposed after one evaluation, including failures. Filter isolation therefore has no
Docker daemon or image-pull requirement; Docker remains a local runtime and verification
prerequisite elsewhere in the product.

Optional API consultation is declarative. Each `filterRequests` entry specifies a response `key`, an authorized `provider`, optional exact `connectionId`, and a relative GET `path`. GitHub paths are pinned under `https://api.github.com/repos/`; Sentry paths are pinned under `https://sentry.io/api/0/`. The worker validates the origin, resolves only the owner's OAuth connection, fetches with a timeout and response limit, parses JSON, then supplies the values as `responses`. Credentials, arbitrary URLs, headers, redirects, and network access never enter the filter guest.

Sentry uses the native project service-hook payload (`group`, `event`) and
`X-ServiceHook-Signature`, as implemented in [Sentry's service-hook sender](https://github.com/getsentry/sentry/blob/master/src/sentry/sentry_apps/tasks/service_hooks.py).
Because `event.created` means an event occurrence, the worker checks the issue's first-seen time
and compares the delivered event ID with the [oldest issue event](https://docs.sentry.io/api/events/retrieve-an-issue-event/)
before admitting a task. Repeated occurrences are ignored without an LLM call. Missing event-read
permission fails visibly; a successful hook registration alone does not prove event-read access.
Provider hook discovery follows bounded same-origin/path pagination before deciding to create a hook.
