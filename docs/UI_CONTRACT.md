# Web and API contract

The browser uses same-origin JSON routes and Better Auth cookies. Authenticated product data is
always scoped to the session's personal owner ID. Responses carry `Cache-Control: no-store`.
A `401` returns the interface to sign-in; validation, conflict, and inactive-product errors remain
visible rather than being converted into success states.

## Authentication and configuration

- `POST /api/auth/sign-in/magic-link` with `{ email, callbackURL: "/" }` sends a ten-minute link.
- `POST /api/auth/sign-out` ends the current session.
- `GET /api/me` returns `{ user: { id, email, name } }`.
- `GET /api/config` returns `{ models: [{ id, name }], localAvailable, boxAvailable, model }`.
- The localhost sign-in screen links to Mailpit at web port `+6`; hosted builds do not expose it.

## Companions, chat, questions, and files

- `GET|POST /api/companions` lists or creates owned Companions. Creation accepts
  `{ name, instructions, provider, avatar }`.
- `GET|PATCH /api/companions/:id` reads detail or updates `{ name, instructions, avatar, modelId }`.
  Avatar is `{ shape: 0..7, color: 0..10, face: 0..4 }`.
- Detail includes `messages`, `runs`, unresolved `questions`, private message `files`, lifecycle
  fields, and `previewText` only for an active main response. The UI suppresses a preview once an
  assistant message with the same `runId` exists.
- `POST /api/companions/:id/messages` accepts
  `{ clientMessageId, content, attachmentCount }` and returns `202 { runId }`.
- `POST /api/companions/:id/cancel` cancels the current main task. A task-specific cancellation is
  `POST /api/companions/:id/runs/:runId/cancel`.
- `POST /api/companions/:id/questions/:questionId/answer` accepts `{ answer }`.
- Each file is uploaded after admission to `POST /api/companions/:id/runs/:runId/files` as multipart
  `file`, stable UUID `clientFileId`, and zero-based `position`. Authenticated file URLs proxy bytes;
  the browser never receives an object key or signed storage URL.

## Connections

- `GET /api/plugins` returns `{ catalog, accounts }`.
- `POST /api/plugins/connect` accepts `{ serverId, label }` and returns an OAuth URL.
- `GET /api/plugins/callback` completes a session-bound OAuth flow.
- `POST /api/plugins/custom` accepts an HTTPS MCP definition; the server also supports bounded
  stdio definitions for control/API callers.
- `DELETE /api/plugins/:accountId` disconnects an owned account.
- `GET /api/companions/:id/plugins` returns selected accounts;
  `PUT|DELETE /api/companions/:id/plugins/:accountId` grants or removes machine access.

## Routines

- `GET|POST /api/companions/:id/routines` lists or creates a routine.
- `GET /api/companions/:id/routines/:routineId/history` returns runs and missed windows;
  `PATCH|DELETE /api/companions/:id/routines/:routineId` changes or removes it.
- Rows use `{ id, name, prompt, cron, timezone, enabled, nextFireAt, createdAt, updatedAt }`.
  The web form currently offers three friendly presets; the backend and control MCP accept valid
  five-field cron plus an IANA timezone.

## Triggers and public webhooks

- Authenticated CRUD is `GET|POST /api/companions/:id/triggers` and
  `PATCH|DELETE /api/companions/:id/triggers/:triggerId`.
- `POST .../:triggerId/test` evaluates without enqueueing; `POST .../:triggerId/register` retries
  managed provider registration; `GET .../:triggerId/deliveries` returns recent decisions.
- Definitions include `name`, `prompt`, `source`, `mode`, optional `filter`, declared
  `filterRequests`, `problemPath`, provider account and target, and `enabled`. Public projections
  include registration state and URL but never a secret. Generic creation returns its secret once.
- `POST /api/webhooks/:triggerId` is public and authenticates its own raw body using the generic,
  GitHub, or Sentry signature contract. It persists receipt and returns `202`; the worker performs
  filtering, provider reads, grouping, and background admission later.

## Templates, delegation, and lifecycle

- `GET|POST /api/templates` lists or creates declarative specialist profiles;
  `PATCH /api/templates/:id` requires `expectedRevision`.
- `GET /api/companions/:id/templates` lists permissions;
  `PUT /api/companions/:id/templates/:templateId` sets `{ maxChildren }`.
- `GET|POST /api/companions/:id/replicas` lists active children or launches one with
  `{ clientCommandId, templateId, prompt }`.
- Lifecycle commands also accept native operation aliases under `/api/companions/:id/` for
  `prepare`, `spawn`, `adopt-template`, `template-permission`, `desktop-takeover`, and
  `desktop-release`. Command IDs remain stable across retries.
- `POST /api/companions/:id/desktop` returns `{ url }` when ready or `202 { preparing: true }`.
  `POST .../desktop/takeover|release` persists human-control intent. The browser polls detail and
  claims control only when `desktopPausedAt` confirms the runtime boundary.

## Billing and client delivery

- `GET /api/billing` returns `{ configured, mode, plan, active, status, currentPeriodEnd,
  cancelAtPeriodEnd, portalAvailable, usage }`. Test activation is labeled separately from a live
  subscription.
- `POST /api/billing/checkout` and `POST /api/billing/portal` return a hosted `{ url }` when the
  configured Stripe state permits them.
- `POST /api/stripe/webhook` is public and verifies the signature over the untouched body before
  applying a deduplicated event.
- `GET|POST /api/deliveries` lists sent/received invitations or creates one from
  `{ clientDeliveryId, companionId, clientEmail, templateIds, maintenanceRequested }`. The web
  retains `clientDeliveryId` across an unchanged retry; the server persists its request fingerprint,
  returns the original invitation for an identical retry, and rejects changed details.
- `POST /api/deliveries/:id/accept` accepts `{ grantMaintenance }` from the matching verified email.
  `DELETE /api/deliveries/:id` revokes a pending sent invitation;
  `DELETE /api/deliveries/:id/maintenance` revokes accepted maintenance consent.

## Current web boundary

The web app exposes Companion creation/chat, activity, identity/model, routines, selected tools,
basic trigger definitions, specialist profiles/launch, client delivery, global connections,
billing/account, and desktop control in compact sheets. Backend-only details such as trigger test
and delivery inspection, routine history, template adoption/rollback, permanent delegation, and
maintenance operations are not presented as completed UI flows. See [v0.md](v0.md).
