# V0 validation — 7 September 2026

`python3 scripts/verify.py` runs the agent unit suites, every isolated server/PostgreSQL suite, the
compiled Linux acceptance path, frontend behavior tests, typechecking, and both production builds.
The final full integrated run passed at `.artifacts/verification/61566c4f5586`, including 22
frontend tests and the runtime fault suites. Artifact paths are local evidence and are not committed.
Earlier measured runs remain under `docs/measurements`; their counts predate the final integration.

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
The latest immutable snapshot was `companions-agent-v3-final-20260907`; re-running its preparation
observed it through GET and performed no reinstall.

The live portable-skills canary on the final V3 Box passed. It verified exported hashes, idempotent
import, discovery through the daemon skills endpoint, and a real Pi tool task that could only
succeed by reading the imported fixture. The persisted PostgreSQL result and private daemon journal
agreed. The daemon also rejected a forged bundle containing a credentials file. The artifact is local and private; this document intentionally omits its unique fixture,
endpoint, and credentials.

## Live Box latency

These are individual real-service observations, not latency percentiles. The first task created and
executed a shell file; the wake task verified that file after archive. Model work differs.

| Observation | Admission | Preparation | Pi execution/result | Total |
| --- | ---: | ---: | ---: | ---: |
| First creation + tool task | 8.508 ms | 19.149 s | 14.150 s | 33.5784 s |
| Archive | — | — | — | 32.1476 s |
| Wake + existing-file tool task | 22.744 ms | 22.230 s | 12.871 s | 35.3106 s |

The wake reused the same Box and observed the file created before archive. Preparation includes
provider transition, service startup, private preview, and controller work; it cannot all be
attributed to Box. The few-second cold/wake goal is **not achieved**, and these single samples do
not establish percentiles or a reliable speedup. No runtime dependency installation occurred. The
committed [final sanitized measurements](measurements/v0-box-2026-09-07.json) contain this observation;
the previous dated file retains the earlier samples.

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
Stripe charge/meter acceptance, complete launch-provider OAuth canary matrix, hosted multi-user
load evidence, or demonstrated few-second cold start. The portable-skill lifecycle has deterministic
coverage and a passing real-Box canary. The runtime concurrency findings for warm-work blocking and executor-leadership fencing are
fixed and covered by twelve focused fault tests. The fully integrated verification
`61566c4f5586` also passes with the invitation claim, shared credential-transfer guards, model
default preservation, and canonical migration ordering. Known credential files and recognizable
secret material are rejected during skill transfer; this is not universal secret detection for
arbitrary package content.
