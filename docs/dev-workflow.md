# Worktree development

Use `./dev --help` from the checkout. This entrypoint resolves its own directory and works
from a subdirectory as well. Python 3.11+, Docker and Git are required. The optional proxy
setup also uses npm; its pinned Node 24 runtime stays inside `tools/dev/node_modules` and
does not replace the machine's Node or the product's pinned Bun.

## First use

```sh
./dev setup --portless
./dev herdr-install  # once per machine, inside Herdr
./dev workspace
```

The Herdr installer backs up existing configuration, validates the candidate and preserves
unrelated bindings. With the default prefix, press **Ctrl+B, then D** to create or reuse the
control panel beside the agent in the same tab. It supports mouse clicks, Tab/arrows and Enter.
It keeps the user's focus in their current pane. `./dev menu` opens the same panel in the
current terminal. The commands remain usable outside Herdr.

The panel offers Start all, Restart all, Stop all, per-service controls, links, logs,
focused validation, scenarios and browser acceptance. Opening the panel alone does not start
containers. A command runs in the background while the panel continues displaying observed
states. Use `o` for its retained output. The sidebar receives expiring app/test metadata.

## Local stack

```sh
./dev up
./dev status --json
./dev service restart api
./dev service stop worker
./dev service start worker
./dev logs executor
./dev restart
./dev down
```

`up` returns only after API, web, executor and worker startup checks succeed. Repeating it
reuses a ready stack or starts manually stopped components. The supervisor serializes
component commands. Unknown outcomes require inspection, not an automatic retry.
Starting one application component from a stopped stack also prepares shared PostgreSQL,
storage and mail dependencies. Other application processes remain stopped. S3 and the storage
console belong to the same MinIO container; their restart/stop buttons control that container.

The CLI starts deterministic local services without inheriting hosted credentials, database
URLs or `.env` values. Billing test access is development-only. The original
`python3 scripts/dev.py` entrypoint remains available for explicitly configured live canaries;
its configuration is separate from the controlled CLI path.

Preparation caches dependencies by lockfile contents and the agent distribution by source
contents. Source changes restart backend processes after stopping admission, applying the
schema and rebuilding the runtime if needed. Existing agent disks and durable request IDs
remain intact; the executor owns recovery. A reload failure remains visible and the watcher
waits for another edit. Manually stopped components remain stopped across source reloads.
Frontend changes use Vite HMR. Changes to launcher scripts require `./dev restart`.

Ports, data, service containers and Linux agent containers belong to the checkout. `down`
stops only owned resources and verifies the container shutdown, retaining disks. It can also
recover owned service processes after a supervisor crash by checking PID start time and
command identity. Stop the test stack after validation, including after failures.

## Portless

`./dev setup --portless` enables pinned Portless. Local HTTP uses one shared loopback proxy
on port 1355, without administrator prompts or changes to `/etc/hosts`. Each worktree has a
distinct hostname. The proxy has separate state under `~/.local/state/companions-portless`.
API, Mailpit, the S3 endpoint and the storage console each get their own named route under the
worktree hostname. Shutdown verifies removal of only that worktree's aliases. If the supervisor
was killed, `./dev down` reconciles its recorded routes; ambiguous ownership remains an explicit
cleanup failure rather than taking another route over.
`./dev up --direct` provides a direct-port fallback.

HTTPS on port 443 is optional: `./dev setup --portless --https` performs Portless's local CA
and privileged-port setup interactively. This can require administrator authentication; run
it once before autonomous starts. All clients need to trust that CA. Configure the shared
proxy consistently across worktrees. Ordinary worktree shutdown preserves the shared proxy.

Read the actual endpoints from `.local/dev-endpoints.json` or `./dev status --json` rather
than reconstructing ports or hostnames. PostgreSQL is a TCP service, not a browser UI; its
credential-free connection address is displayed separately. Workers expose logs, not web links.

## Validation and evidence

```sh
./dev check web
./dev check server --test retirement
./dev check agent
./dev check full
./dev scenario chat-ready
./dev scenario cancel-recovery
./dev browser-test chat-recovery
```

Focused checks prepare their own isolated dependencies. Scenarios and browser acceptance
require a running `./dev up` stack and refuse live-model configurations. Authentication uses
real Better Auth magic links delivered to the local Mailpit. The browser command requires
`agent-browser`, uses its own session, and verifies a message submitted through the UI against
persisted API state after reload. It saves screenshots and accessibility snapshots, and closes
its browser session even on failure. Browser network traces are deliberately excluded because
they contain authentication cookies.

Reports live under `.artifacts/verification`, `.artifacts/dev-scenarios` and
`.artifacts/browser-tests`. Verification records source identity, the reproduction command,
step results, timeout information and cleanup. The panel marks old evidence stale when code
changes. A focused passing result names its profile; it does not replace full validation.
GitHub's Verify workflow runs the full PostgreSQL 18 path and uploads only summary JSON,
excluding local authentication state, database backups and raw logs. Configure Verify as a
required repository check if merges must be blocked on it.

### Conversation message migration

`conversation.sql` replaces the one-message-per-role constraint with a sequence per run and
role, retaining all existing rows at sequence zero. Build the agent distribution first. Stop
the previous executor before applying this migration, then start the updated server/executor:
the old executor's final-message conflict target is incompatible with the new index. Updated
servers accept older agent journals through the legacy final-answer path; existing Boxes need
the updated distribution to capture future intermediate messages.

For rollback, retain the new schema and the compatible executor settlement code. Restoring
the old unique constraint after multi-message runs exist requires a separately reviewed data
migration; do not delete conversation rows to make an old binary start. This change cannot
recover intermediate messages that older runtimes never saved.

### Routine publication mode rollout

This release requires a coordinated update of API, worker and executor. The new columns are
additive, but old executors ignore `publication_mode` and old workers admit scheduled runs with
the default mode. Applying the migration alone does not stop an existing executor leader.
Do not expose the new settings while any old application role remains running.

1. Pause automatic deployments for all three application services **before merging** this release.
   Build the release image and its agent distribution before deployment.
2. Stop the old API to stop new admissions, then stop the old worker and executor. Verify all
   three old roles have stopped before running the migration. Preserve agent journals, durable
   request IDs, Boxes and disks; stopping the services is not permission to replay agent work.
3. Run `migrate` from the new image. Start the updated executor and worker, verify startup and
   recovery, then start the updated API from that same image and restore user access. Resume
   automatic deployments only after every role is on the new version.

For rollback, stop admission through the API and stop the worker first. Keep the updated
executor until all accepted `always` and `silent` executions have settled under their recorded
policy, including queued and waiting-for-input work. If this cannot be completed, retain the
updated release; do not downgrade a pending publication decision. Before downgrading, change
future routine modes to `auto` through the updated control/API in an operator-only maintenance
window, with the worker still stopped, then stop all application roles. Retain the additive
columns and deploy the previous compatible image to all roles together. Do not delete runs,
messages or journals, or automatically replay ambiguous work as part of rollback.

### Real model or scripted responses

`./dev restart --live` uses the selected runtime settings described below.
Database and storage remain local; agent computers use Box when its key and template are configured.
The worktree remembers this choice without writing credentials to its options file.
`./dev restart --scripted` restores deterministic test responses. The default for a new
worktree is scripted mode unless the shared `.env` sets `DEV_LIVE_MODEL=1`; `Scripted response.` indicates that mode, not an AI answer.
Existing messages are retained when switching modes. Send a new message to use the real model.

### Shared runtime settings from the main checkout

In live mode, the launcher reads runtime settings from the main checkout’s `.env`
(found through Git’s common directory), then this worktree’s `.env`, then the shell.
It reads them again on each startup; secrets are not copied into worktree options.
Only `MODEL_PROVIDER`, `MODEL_ID`, the selected provider’s API key and endpoint,
`DEV_LIVE_MODEL`, `LOCAL_RUNTIME`, `BOX_API_KEY` and `BOX_TEMPLATE` are inherited. Database, storage, authentication, email and ports
remain local. Scripted mode does not inherit these external credentials.

Use `./dev restart --live --direct` to apply changes. With both Box settings present,
new specialists use Box; existing Docker specialists retain their provider.
For ZAI Coding Plan, use `MODEL_PROVIDER=zai` and `MODEL_ID=glm-5.3-flash` in the
main `.env`. Pi’s `zai` provider uses `https://api.z.ai/api/coding/paas/v4`.

For Azure Foundry, configure the main checkout’s ignored `.env`:

```dotenv
MODEL_PROVIDER=azure
MODEL_ID=gpt-5.6-luna
AZURE_OPENAI_BASE_URL=https://YOUR-RESOURCE.services.ai.azure.com/api/projects/YOUR-PROJECT/openai/v1
AZURE_OPENAI_API_KEY=<your-key>
DEV_LIVE_MODEL=1
```

`MODEL_ID` is the Azure deployment name. The base URL also accepts a full
`/responses` endpoint. Azure uses the Responses protocol through the same run-scoped
gateway, preserving native streaming, function tools, images, reasoning and token usage.
In production, set the key and endpoint on the API; API, executor and worker use the
same provider and model defaults. The global key must never reach a Box.
The [Microsoft Responses reference](https://learn.microsoft.com/en-us/rest/api/aifoundry/azureopenai/responses)
describes this API.

`DEV_LIVE_MODEL=1` makes local startup use the shared model unless the worktree has
an explicit mode saved. `./dev restart --live` overrides a previous scripted choice;
`./dev restart --scripted` remains deterministic. A worktree `.env` model override
still takes precedence over the main checkout and must be removed to follow it.

### Herdr worktree `.env` copy

The repository’s shared Git `post-checkout` hook is installed locally from
`scripts/herdr-copy-env.py`. When `HERDR_ENV=1`, it copies the primary checkout’s
`.env` into a newly created worktree if none exists. The copy has mode `0600` and
must be ignored by Git. Existing worktree settings are never overwritten.
The hook is shared by this repository’s worktrees and requires no Herdr restart.
Use `./dev up --live` in a new worktree to activate the external runtime settings
while keeping development infrastructure isolated. Local `.env` copies take
precedence over later changes to the main file.

### Specialist images and Box snapshot capacity

New specialist versions retain a sealed, archived Box and store a `box:<id>` image
reference. Missions fork that Box with an idempotency key, `noEnv: true`, and an
empty environment. The configuration source is archived before its sanitation
copy is made; the sanitized image is archived and retired before publication.
Published images must never be resumed, mutated or deleted while referenced by
versions or shared copies. Existing named snapshot versions still work.

Retention policy checked on 2026-09-08 against [Snapshots & Copies](https://docs.ascii.dev/box/snapshots#retention),
[Data retention](https://docs.ascii.dev/box/data-retention), and the [FAQ](https://docs.ascii.dev/box/faq):
there is no documented seven-day expiry for the latest snapshot. It remains usable
for the lifetime of the archived Box, including months later. Seven days refers to
the free trial. Stopped Boxes and their latest snapshot are included without running
compute charges; this is the documented service policy, not an independent backup.

Keep the sealed-Box strategy; do not schedule periodic wakeups or rotation to extend
retention. Account zero-data-retention must remain disabled: read it with
`GET /account/data-retention` before adopting this storage strategy. Enabling it
queues existing archived Boxes for deletion and discards future archives; disabling
it does not cancel accepted deletions. Explicit Box deletion also removes the restore
source. Closing the Box account starts a 30-day recovery window before data purge.
Named snapshots have no expiry but remain limited to 10. An independent off-provider
backup would require its own export and tested restore path.

Specialist names and avatars are live metadata: saving them updates the library,
configuration chat and existing active mission identities immediately. It does not
publish instructions, increment the technical revision, or invalidate a tested image.

A development distribution can use the same mechanism:
`python3 scripts/bun.py scripts/prepare-box-template.ts <unique-release> --archived`.
The command builds first, verifies every file on an independent fork, archives both
owned Boxes, and prints the `BOX_TEMPLATE=box:<id>` setting for the worktree `.env`.


### Box by default; opt-in local testing

The product does not expose a local/cloud computer picker. New companions and
specialist configuration environments use Box by default. Existing local companions
remain readable and runnable; a prepared specialist always launches a Box child,
even when its coordinator is local.

For fast Docker-backed local testing, set `LOCAL_RUNTIME=1` in the worktree `.env`
or shell and restart with `./dev restart`. Remove it or set `LOCAL_RUNTIME=0` to
return to Box. This setting is independent of model selection: `--scripted` controls
the test model, while `--live` uses configured model credentials. Live Box development
still requires `BOX_API_KEY` and `BOX_TEMPLATE`. Deterministic verification explicitly
enables the local runtime in its isolated test environment.
