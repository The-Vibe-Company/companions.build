# companions.build

Persistent AI companions with their own computer. Each personal account owns an isolated set of
Companions, conversations, connections, automations, templates, files, and billing records. Pi is
the agent harness, Bun packages the Linux runtime, PostgreSQL is the durable control plane, and the
web client uses React, shadcn/ui, and AI Elements.

The repository currently implements the local product path and the hosted integration boundaries.
It is not evidence that the hosted service, provider OAuth applications, Stripe prices, or cold
Box performance are production ready. See [the V0 status and gaps](docs/v0.md).

## Run locally

Prerequisites are Python 3, Docker, and Git. The launcher downloads checksum-verified Bun 1.4.2
inside the checkout and starts isolated PostgreSQL, MinIO, Mailpit, API, worker, executor, and web
processes.

```sh
git clone https://github.com/The-Vibe-Company/companions.build.git
cd companions.build
python3 scripts/dev.py
```

Open the printed web address, enter an email, then use the link in the printed Mailpit address.
Local mode uses a deterministic Pi test model by default. Create a Companion and send `write-note`
to exercise a real Pi tool call inside its Linux container. `slow-write` exercises cancellation;
`crash-after-effect` exercises recovery without repeating the tool effect.

Each checkout derives its own ports, database, object bucket, mail inbox, and labeled containers.
Set `CONDUCTOR_PORT` to choose an explicit web port; API is `+1`, PostgreSQL `+2`, MinIO `+3`,
Mailpit SMTP `+5`, and Mailpit web `+6`. Ctrl-C stops resources owned by that checkout while
retaining its local data.

For real model responses, create an uncommitted `.env`:

```dotenv
AGENT_TEST_MODE=0
MODEL_PROVIDER=google
MODEL_ID=gemini-2.5-flash
GEMINI_API_KEY=your-key
```

Google, Anthropic, OpenAI, OpenRouter, and Z.AI Coding Plan are supported. The UI projects the
configured model catalog and stores a validated model choice per Companion. Restart the launcher
after changing configuration.

The local launcher applies the complete PostgreSQL schema before it starts any service. A hosted
release must use the same order: run `bun run migrate` as its release command, then start API,
executor, and worker with `COMPANIONS_SCHEMA_PREPARED=1`. Each service verifies the stored schema
fingerprint before becoming ready. A service launched on its own without that flag still performs
the idempotent, advisory-locked migration and skips DDL when the current fingerprint is present.

## Run the production container

The root image builds the Vite client and frozen Linux agent with Bun 1.4.2. It defaults to the
`api` role on `0.0.0.0:$PORT` and serves the client from the same origin. Run `migrate` once for a
release, then launch `api`, `executor`, and `worker` as separate services from the same image:

```sh
docker build -t companions.build .
docker run --rm --env-file production.env companions.build migrate
docker run --env-file production.env -p 3000:3000 companions.build api
docker run --env-file production.env companions.build executor
docker run --env-file production.env companions.build worker
```

`production.env` must provide `DATABASE_URL`, the public HTTPS `APP_URL`, `BETTER_AUTH_SECRET`, and
a 64-character hexadecimal `COMPANIONS_ENCRYPTION_KEY`. Configure SMTP for magic-link login and S3
for chat files. Box, model-provider, OAuth, and Stripe credentials are required only for the product
surfaces enabled in that deployment; absence remains visible as unavailable and is not simulated.
Only the API role needs an exposed port. Trigger filters run inside the image's bounded QuickJS
WebAssembly runtime, so API, executor, and worker services do not need a Docker socket.
`LOCAL_RUNTIME=0` is the image default; a hosted executor uses Box rather than attempting to launch
local agent containers.

Put the selected model-provider key on the API service only. In production, model requests use
`${APP_URL}/api/model-gateway` (or an explicit HTTPS `MODEL_GATEWAY_URL` ending in
`/api/model-gateway`). The executor gives each admitted run a signed, expiring credential; Box
receives no platform model key. The gateway checks the current run, owner and selected model before
forwarding each request. Provider-reported usage is recorded independently of the agent transcript.
Development without `MODEL_GATEWAY_URL` retains the direct-provider path for owned local canaries.

Run the isolated image acceptance (it creates and removes its own PostgreSQL container and network):

```sh
bun scripts/test-production-container.ts
```

## Run on Box

Prepare the frozen runtime once, then create Box-backed Companions from it:

```sh
# Set BOX_API_KEY in .env first. Never commit credentials.
python3 scripts/bun.py scripts/prepare-box-template.ts companions-agent-v5-20260907
# Add BOX_TEMPLATE=companions-agent-v5-20260907 to .env, then restart scripts/dev.py.
```

The executor creates or resumes the same Box and owns every Pi run. It
stages the selected model, plugins, files, trigger context, and control MCP, and persists intent
before each external effect. Opening the desktop wakes the Box when necessary. Human takeover is
shown as complete only after the runtime confirms the agent is paused. The authorized API route
retrieves the provider desktop URL after readiness; it never dispatches a Pi run.

Live Box canaries have covered creation, tools, archive/resume, desktop access, physical takeover,
memory/history, and delegated-file handoff across immutable snapshots through
`companions-agent-v5-20260907`. The recorded cold/wake timing sample came from
`companions-agent-v3-final-20260907`: 33.6 seconds for first creation and 35.3 seconds for wake. It
does not establish V5 latency or the desired few-second cold path. See
[measured validation](docs/validation-v0.md).

## Product surfaces

- Better Auth email magic links with PostgreSQL sessions and owner-scoped data.
- Durable main chat with native Pi steering, cancellation, questions, Markdown, and private files.
- Background routines, signed webhooks, code filters, provider reads, grouping, shared durable
  memory, explicit publish-to-chat, and task history.
- OAuth and custom MCP connections selected independently for each Companion.
- The `companion-control` MCP for identity, models, routines, triggers, tasks, delegation,
  templates, lifecycle operations, plugins, and delivery preparation.
- Permanent Companions, temporary specialist replicas, immutable template revisions and rollback,
  Box snapshot adoption, and retained results.
- Stripe Checkout/portal/webhooks, a deduplicated usage ledger, and independent client delivery
  with an explicit, revocable, audited maintenance surface.
- Portable local-skill export, validation, private object-storage transfer, and import are wired
  into delivery and template preparation, with deterministic coverage and a real-Box canary.

## Verify

```sh
# Fresh PostgreSQL and MinIO, server behavior, compiled Pi/Linux product path, web tests and build
python3 scripts/verify.py

# Wider packaging matrix: tools, MCP transports, skills, images, steering, sessions, and faults
python3 experiments/pi-bun/verify.py
python3 experiments/pi-bun/verify.py --scenario 'crash after'

# Credentialed canaries; these may create billable provider resources
AGENT_TEST_MODE=0 python3 scripts/bun.py scripts/live-model-canary.ts
python3 scripts/bun.py scripts/live-box-canary.ts
python3 scripts/bun.py scripts/live-box-canary.ts --wake-only
python3 scripts/bun.py scripts/live-desktop-canary.ts
```

Read [the testing guide](docs/testing.md) before interpreting a passing suite. Deterministic tests
prove product behavior at controlled boundaries; they do not prove model quality, live OAuth,
Stripe pricing, provider reliability, or hosted latency.

## Documentation

- [Current implementation, architecture, and gaps](docs/v0.md)
- [Approved product decisions](docs/companions-build.md)
- [Web/API contract](docs/UI_CONTRACT.md)
- [Testing and evidence](docs/testing.md)
- [Billing and client delivery](docs/billing-delivery.md)
- [Lifecycle, templates, and replicas](docs/lifecycle.md)
- [Triggers](docs/triggers.md)
- [Files](docs/files.md)
- [Pi/Bun feasibility](docs/research/pi-bun-feasibility-2026-09-06.md)

The project is MIT licensed. Never commit `.env`, provider keys, authentication links, local state,
or verification artifacts.
