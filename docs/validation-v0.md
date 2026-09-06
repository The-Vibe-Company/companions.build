# V0 validation — 6 September 2026

`python3 scripts/verify.py` runs the agent unit suites, every isolated server/PostgreSQL suite, the
compiled Linux acceptance path, frontend behavior tests, typechecking, and both production builds.
The last integrated run passed at `.artifacts/verification/43c66c5435a3`. Artifact paths are local
evidence and are not committed. The older timed run remains in
[the measured run](measurements/v0-local-2026-09-06.json); its test counts predate activation,
maintenance, template-history, asynchronous lifecycle, and portable-skill coverage.

The integrated Linux scenario exercises real Pi read/write/bash tools through the controller:
two independent Companions, cancellation during a shell command, process death after a filesystem
effect, journal recovery as interrupted without a repeated effect, then successful later work.
PostgreSQL suites cover concurrent duplicate admissions, changed-content rejection, cross-account
authorization, competing executors, ownership loss, async preparation, activation revocation,
maintenance revocation, template rollback, and portable-skill validation and transfer.

Manual browser checks at 1440×900 and 390×844 verified real magic-link login, creation, chat,
preparation, persisted results, navigation, automation setup/test/history, and compact sheets. These
local test-model observations do not measure LLM or Box provisioning performance.

The separate packaging experiment passes 11 checks for Linux without package managers, native Pi
steering, separate chat/background transcripts, shell cancellation, skill resources, stdio and HTTP
MCP, image resize, and restart. Its reviewed run executed 11 tests in 51.6 seconds including setup
and compilation. A forced two-second test timeout failed and cleaned its own containers.

After the owner configured Z.AI Coding Plan, **GLM-5.3-Flash passed the real-model canary** in 6.55
seconds including Linux startup. The tool variant passed in 5.53 seconds by creating `canary.sh`,
executing it through Pi, and independently verifying the file and exact result. The web chat also
returned a persisted French response using this model.

After Box configuration, canaries passed snapshot lookup, creation, real file/shell tools,
archive/resume of the same machine, file persistence, desktop URL retrieval, and physical takeover.
The latest snapshot was `companions-agent-v1-20260906`.

## Live Box latency

These are individual real-service observations, not latency percentiles. The first task created and
executed a shell file; the wake task verified that file after archive. Model work differs.

| Observation | Admission | Preparation | Pi execution/result | Total |
| --- | ---: | ---: | ---: | ---: |
| First creation + tool task | 9.05 ms | 6.813 s | 13.737 s | 20.9725 s |
| Archive | — | — | — | 24.3396 s |
| Wake + existing-file tool task | 26.48 ms | 24.510 s | 9.473 s | 34.3418 s |

The wake reused the same Box and observed the file created before archive. Preparation includes
provider transition, service startup, private preview, and controller work; it cannot all be
attributed to Box. The few-second cold/wake goal is **not achieved**, and these single samples do
not establish percentiles or a reliable speedup. No runtime dependency installation occurred. The
committed [sanitized measurements](measurements/v0-box-2026-09-06.json) contain earlier samples and
must not be mistaken for this latest observation.

## Live desktop takeover

`scripts/live-desktop-canary.ts` started a real `bash` subprocess that would normally sleep for 25
seconds. Runtime-confirmed takeover froze it for 28 seconds, release resumed it, and the task then
completed successfully. A VNC session also opened and operated a terminal on the same desktop.
This proves process suspension/resumption for that one live Box and interaction through VNC. It
does not prove every GUI application, failure mode, browser session, or provider state.

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
- Desktop readiness lagged daemon readiness: retain the user-opened tab and poll until the provider returns a URL.
- Portable-skill migrations initially ran after a maintenance fixture expected their columns: the
  integrated migration order was corrected before the green verification run.

The V0 has working local and targeted live paths, but it is not a launch proof. There is no live
Stripe charge/meter acceptance, complete launch-provider OAuth canary matrix, hosted load or tail
latency evidence, or demonstrated few-second cold start. Portable skill delivery still needs its
final integrated wiring and acceptance before it can be described as complete.
