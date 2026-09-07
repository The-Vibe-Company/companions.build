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
