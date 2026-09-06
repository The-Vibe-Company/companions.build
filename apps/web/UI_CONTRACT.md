# Web API contract

The web client uses same-origin cookie sessions. A `401` from any authenticated route returns the interface to sign-in.

## Account

- `POST /api/auth/sign-in/magic-link` with `{ email, callbackURL: "/" }` sends the sign-in email.
- `POST /api/auth/sign-out` ends the current session.
- `GET /api/me` returns `{ user: { id, email, name } }`.
- Localhost alone links to Mailpit at web-port + 6. Hosted builds never show that link.

## Companions and files

- `GET /api/config` includes `models: [{ id, name }]`; Companion projections include the selected `modelId` and `avatar: { shape: 0..7, color: 0..10, face: 0..4 }`.
- Create accepts `{ name, instructions, provider, avatar }`. `PATCH /api/companions/:id` accepts `{ name, instructions, avatar, modelId }` and returns `{ companion }`.
- Message admission accepts `{ clientMessageId, content, attachmentCount }` and returns `202 { runId }`.
- Each selected file is then uploaded to `POST /api/companions/:companionId/runs/:runId/files` as multipart `file`, stable UUID `clientFileId`, and zero-based `position`.
- Detail maps files onto their message as `files: [{ id, runId, kind, name, mimeType, size, url }]`. The authenticated `url` is used for download.

## Connections

- `GET /api/plugins` returns `{ catalog, accounts }`. Catalog rows use `{ id, name, description?, provider?, kind? }`; account rows use `{ id, serverId, label, provider? }`.
- `POST /api/plugins/connect` accepts `{ serverId, label }` and returns an OAuth `url` or the connected `account`.
- `POST /api/plugins/custom` accepts `{ label, url }`; `DELETE /api/plugins/:id` disconnects an account.
- `GET /api/companions/:id/plugins` returns `{ accounts }`; `PUT` or `DELETE /api/companions/:id/plugins/:accountId` grants or removes Companion access.

## Routines and triggers

- Routine CRUD uses `/api/companions/:id/routines[/:routineId]`. Rows are `{ id, name, prompt, cron, timezone, enabled, nextFireAt, createdAt, updatedAt }`.
- Trigger CRUD uses `/api/companions/:id/triggers[/:triggerId]`. Creation sends `{ name, prompt, source, mode, filterCode?, enabled }`. The UI understands `registrationStatus` and `url` projections; generic creation may return a one-time `secret`.
- The first UI exposes friendly routine presets. Trigger code is shown only when filtering is enabled.

## Billing and delivery

- `GET /api/billing` returns `{ configured, mode, plan, active, status, currentPeriodEnd, cancelAtPeriodEnd, portalAvailable, usage }` without projecting an active subscription when none exists.
- `POST /api/billing/checkout` and `POST /api/billing/portal` return `{ url }` for their hosted Stripe surface.
- `GET /api/deliveries` returns `{ sent, received }`. Creation accepts `{ clientDeliveryId, companionId, clientEmail, templateIds, maintenanceRequested }`; `clientDeliveryId` remains stable across a retry of the same form intent. Acceptance sends the recipient's explicit `{ grantMaintenance }` choice.

## Specialists and desktop

- `GET/POST /api/templates` lists and creates portable specialist profiles. `PATCH /api/templates/:id` includes `expectedRevision`.
- `GET/POST /api/companions/:id/replicas` lists active or retained children and launches one with `{ clientCommandId, templateId, prompt }`.
- `PUT /api/companions/:id/templates/:templateId` sets `{ maxChildren }` before launch.
- `POST /api/companions/:id/desktop/takeover` requests physical pause; `POST .../release` requests thaw. The UI polls Companion detail and says control is held only after `desktopPausedAt` is present.
