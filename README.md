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

## Run on Box

Prepare the frozen runtime once, then create Box-backed Companions from it:

```sh
# Set BOX_API_KEY in .env first. Never commit credentials.
python3 scripts/bun.py scripts/prepare-box-template.ts companions-agent-v0
# Add BOX_TEMPLATE=companions-agent-v0 to .env, then restart scripts/dev.py.
```

The executor is the only process that contacts Box or Pi. It creates or resumes the same Box,
stages the selected model, plugins, files, trigger context, and control MCP, and persists intent
before each external effect. Opening the desktop wakes the Box when necessary. Human takeover is
shown as complete only after the runtime confirms the agent is paused.

Live Box creation, tools, archive/resume, and desktop access have targeted canaries. Measurements
from 6 September 2026 still show cold creation and wake taking tens of seconds; the desired
few-second cold path has not been achieved. See [measured validation](docs/validation-v0.md).

## Product surfaces

- Better Auth email magic links with PostgreSQL sessions and owner-scoped data.
- Durable main chat with native Pi steering, cancellation, questions, Markdown, and private files.
- Background routines, signed webhooks, code filters, provider reads, grouping, shared durable
  memory, explicit publish-to-chat, and task history.
- OAuth and custom MCP connections selected independently for each Companion.
- The `companion-control` MCP for identity, models, routines, triggers, tasks, delegation,
  templates, lifecycle operations, plugins, and delivery preparation.
- Permanent Companions, temporary specialist replicas, Box snapshot adoption, and retained results.
- Stripe Checkout/portal/webhooks, a deduplicated usage ledger, and independent client delivery
  with an explicit, revocable maintenance grant record.

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
