# V0 validation — 6 September 2026

`python3 scripts/verify.py` runs 29 checks: 11 daemon/initialization/environment tests, 12 API,
PostgreSQL and Linux integration tests, and 6 frontend behavior tests. It also typechecks and builds
the Linux distribution and production web bundle. The cached run takes about 13 seconds on the
development Mac; see [the measured run](measurements/v0-local-2026-09-06.json).

The integrated Linux scenario exercises real Pi read/write/bash tools through the controller:
two independent Companions, cancellation during a shell command, process death after a filesystem
effect, journal recovery as interrupted without a repeated effect, then successful later work.
Other PostgreSQL tests cover twenty concurrent duplicate admissions, changed-content rejection,
unauthenticated/cross-origin writes, competing executors, loss of ownership and reconciliation of
a result already persisted by the daemon.

Manual browser checks at 1440×900 and 390×844 verified login, create, first send, preparation,
durable result, navigation and no browser errors. The user-facing Linux run accepted the message
in 9.8 ms and returned the file-tool result after about three seconds. These are local test-model
measurements, not LLM or Box provisioning benchmarks.

The separate packaging experiment passes 11 checks for Linux without package managers, native
Pi steering, separate chat/background transcripts, shell cancellation, skill resources, stdio and
HTTP MCP, image resize and restart. Its final run after review executed 11 tests in 51.6 seconds,
including setup and compilation. A forced two-second test timeout failed and cleaned its containers.

The initial live-model attempt lacked a configured key; the daemon now reports
`MISSING_MODEL_API_KEY` at startup and the canary checks configuration before creating a container.
After the owner configured Z.AI Coding Plan, **GLM-5.3-Flash passed the real-model canary** in 6.55 s,
including Linux startup. The tool variant passed in 5.53 s: create `canary.sh`, execute it through
Pi, verify the actual file and exact model result. The web chat also returned a persisted French
response using this model. After configuring Box, the live canary also passed snapshot creation,
a new machine from that snapshot, real file/shell tools, archive/resume of the same machine,
file persistence and retrieval of the desktop URL. Cold/wake performance remains open in THE-562.

## Live Box latency

These are individual real-service observations, not latency percentiles. The first task created and
executed a shell file; later READY probes intentionally requested no tools. Model work differs.

| Observation | Preparation | Agent execution/result | Total until persisted response |
| --- | ---: | ---: | ---: |
| First creation + tool task | 42.9 s until Pi prompt | 4.7 s Pi | 48.0 s |
| Initial wake + existing-file tool task | 57.5 s until Pi prompt | 11.3 s Pi | 69.2 s |
| Already-running READY probe | 0.55 s | 5.0 s | 5.6 s |
| First optimized wake READY probe | 28.8 s | 25.2 s | 54.0 s |
| Later wake READY probe with startup grace | 87.3 s | 1.2 s | 88.9 s |

The later provider observation did not reach ready until 57.4 s, compared with 19.0 s in the prior
wake. Preparation also includes service startup, private preview and controller work; it cannot all
be attributed to Box. The few-second cold/wake goal is **not achieved**, and these samples do not
prove a reliable speedup. Admission remained under 22 ms in these live tests. No runtime dependency
installation occurred. [Sanitized measurements](measurements/v0-box-2026-09-06.json).

## Defects found and corrected during this slice

- Box remote commands lacked the user service bus: explicitly set XDG/DBus and enable linger in the template.
- Private preview redirects lost their authentication cookie: bounded same-origin, same-path cookie exchange.
- An archived endpoint consumed a health timeout before resume: observe lifecycle first and reuse prepared configuration.
- Provider readiness preceded daemon readiness: bounded health/startup grace before reconfiguration.
- Simultaneous fresh API/executor startup raced PostgreSQL schema creation: transactional migration lock.
- Docker changed the host port after restart: reconnect to the same journal, never redispatch.
- Rebuilding removed files mounted by live agents: immutable release directories and atomic alias changes.
- Re-extracting Bun overwrote a running macOS executable: checked cache and atomic inode replacement.
- Pi's `agent_end` occurred before post-run completion: settle on `agent_settled`.
- Credentials leaked into routine shell inheritance: capture into memory, scrub environment, keep temporary env files outside the agent mount.
- Configuration changes left old credentials active: reconcile a configuration digest before later work.
- Cancelling initialization could occupy the lane indefinitely: bounded, cancellation-aware initialization with disposal of late sessions.
- Browser retries generated new request IDs: retain the pending request ID until acknowledgment.
- Switching Companions retained a draft: key the chat by Companion identity.

The V0 is an operator workspace. Hosted accounts, native product steering/streaming, routines,
plugins, triggers, control MCP and coordinated desktop takeover are not complete features yet.
