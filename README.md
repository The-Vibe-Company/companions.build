# companions.build

Persistent AI companions with their own computer. Pi is the harness, Bun packages the runtime,
and the web app uses shadcn/ui and AI Elements. MIT licensed.

The first slice creates a Companion, launches its Linux computer on the first message, persists
the conversation, cancels work and recovers after restart without replaying ambiguous tool actions.
This is a single-operator development workspace, not the hosted subscription product yet.

## Run locally

Prerequisites: Python 3, Docker running, Git. The launcher downloads a checksum-verified Bun 1.4.2
into this checkout; it does not replace your global runtime.

```sh
git clone https://github.com/The-Vibe-Company/companions.build.git
cd companions.build
python3 scripts/dev.py
```

Open the address printed by the launcher. The access token lives in `.local/operator-token`.
Create a Companion, choose Local, and send `write-note`: real Pi writes and reads a file inside
its Linux container. Default local mode explicitly uses a deterministic test model, not an LLM.
`slow-write` exercises cancellation; `crash-after-effect` is a fault-injection scenario.

For real responses, create `.env`:

```dotenv
AGENT_TEST_MODE=0
MODEL_PROVIDER=google
MODEL_ID=gemini-2.5-flash
GEMINI_API_KEY=your-key
```

Supported initial providers: Google, Anthropic, OpenAI, OpenRouter and Z.AI Coding Plan. Set the corresponding
`MODEL_PROVIDER`, `MODEL_ID` and standard API key. `GOOGLE_API_KEY` is accepted as a Google alias.
Restart the launcher after configuration changes. It refreshes a machine's configuration before
its next task. Pi's shell and files execute inside that machine, never on the host.

For Z.AI Coding Plan, use `MODEL_PROVIDER=zai`, `MODEL_ID=glm-5.3-flash` and `ZAI_API_KEY`.
Pi uses the dedicated Coding Plan endpoint. The model is listed in the
[official Coding Plan documentation](https://docs.z.ai/devpack/overview).

Each checkout gets its own database container, ports and state. Override `WEB_PORT` or
`CONDUCTOR_PORT` for an explicit base port; API uses base+1 and PostgreSQL base+2. Ctrl-C stops
the application processes. Agent containers and PostgreSQL retain their state for the next start.

## Run on Box

Build a frozen template once, then launch new Companions from it:

```sh
# First set BOX_API_KEY in .env. Do not commit credentials.
python3 scripts/bun.py scripts/prepare-box-template.ts companions-agent-v0
# Then add BOX_TEMPLATE=companions-agent-v0 to .env and restart dev.py.
```

Choose Box in the creation form. The executor creates a Box from the prepared template and resumes
that same Box when archived. The executable, Pi dependencies and Photon WASM are already present;
there is no runtime package installation at wake. The template script archives its build Box
after a successful snapshot and saves a resumable preparation journal in `.local`.

The Box adapter and template path are implemented against the official API. **Live Box create,
snapshot and resume have not yet been verified in this environment because no Box key is configured.**
Docker timings do not predict provider provisioning latency. A Box desktop link is available once
ready; coordinated GUI takeover/release remains a later feature.

## Verify and reproduce

```sh
# Fresh isolated PostgreSQL, real Pi/Linux, crash/cancel scenarios, frontend tests/build
python3 scripts/verify.py

# Wider packaging proof: MCP transports, skills, images, native steering, independent lanes
python3 experiments/pi-bun/verify.py
python3 experiments/pi-bun/verify.py --scenario 'crash after'

# Optional: one paid request to your configured model, inside Linux
AGENT_TEST_MODE=0 python3 scripts/bun.py scripts/live-model-canary.ts
```

Evidence is retained in `.artifacts/verification`, `.artifacts/system-tests` and `.artifacts/pi-bun`.
The system suite kills an agent after an actual shell effect, restarts it, verifies no repeated
effect and checks that the next task succeeds. Verification uses its own temporary database.

## Product and architecture

- [Current V0 boundary and architecture](docs/v0.md)
- [Approved product decisions](docs/companions-build.md)
- [Linear tickets](docs/tickets.md)
- [Pi/Bun Linux findings and measurements](docs/research/pi-bun-feasibility-2026-09-06.md)
- [Agent daemon protocol](packages/agent/README.md)

The first chat currently queues messages while work is active. Native steering is proven in the
packaging experiment but is not yet wired into the product transport. Routines, triggers, plugins,
control MCP, delegation, templates for clients and billing remain tracked in Linear.

The installation token protects the local API. Machine endpoint credentials are encrypted in
PostgreSQL. Treat each agent's computer as a trusted execution environment for its configured
accounts: process-environment scrubbing prevents routine shell inheritance, not a malicious
program's access to same-user machine state. Hosted tenant isolation is a separate milestone.

The live-model canary passed with Z.AI Coding Plan / GLM-5.3-Flash on 6 September 2026.
Keep live model checks separate from the deterministic acceptance suite.
