# V0 validation — 7 September 2026

`python3 scripts/verify.py` runs the agent unit suites, every isolated server/PostgreSQL suite, the
compiled Linux acceptance path, frontend behavior tests, typechecking, and both production builds.
The final product-core run passed at `.artifacts/verification/bcdfc7fd8178`, with the account,
template, history, handoff, and shared-memory fixes integrated. Artifact paths are local evidence
and are not committed. Earlier measured runs remain under `docs/measurements`; their counts predate
the final integration.

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
The V3 snapshot `companions-agent-v3-final-20260907` was observed through GET on re-entry and was
not reinstalled. The latest immutable distribution is `companions-agent-v5-20260907`; its delegated
file and memory/history canaries are described below.

The live portable-skills canary on the V3 snapshot passed. It verified exported hashes, idempotent
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
fixed and covered by twelve focused fault tests. Final product-core verification `bcdfc7fd8178`
covers the invitation claim, shared credential-transfer guards, model default preservation,
canonical migration ordering, account isolation, template serialization, history search,
delegated-file handoff, and shared-memory conflict handling. Known credential files and recognizable
secret material are rejected during skill transfer; this is not universal secret detection for
arbitrary package content.

## Final delegation and memory acceptance

The V5 frozen distribution (`companions-agent-v5-20260907`) includes versioned shared-memory
updates, targeted history search and delegated question replies. The real Box handoff canary
passed: a child generated an unknown UUID, returned it only through `send_file`, and its Box was
archived while the parent remained physically paused. After release, the parent read the retained
file from object storage and returned the exact UUID. The mobile Activity download returned HTTP
200 with the same bytes and no horizontal overflow. No child runtime was needed for that read.

The deterministic suites additionally prove concurrent memory conflicts, restart persistence,
workspace isolation, bounded same-Companion history search, multi-hop and concurrent delegation
cycle rejection, and later-parent-turn clarification. Account acceptance uses a real Better Auth
logout to reject the formerly valid cookie; two deliveries from one source remain independent;
late metering retains its original timestamp after a simulated subscription period change.
Concurrent template promotion produces one revision, and a new child created after source
retirement receives the pinned snapshot with fresh identity and state.

A second V5 live task found that earlier review through `history_search` and merged its exact run
ID into shared memory using the native read/update tools. The canary independently read the Box
file and verified the stored ID; the search result ID was not included in the task prompt.

The V5 chat-driven skill-install canary also passed: authenticated SKILL.md upload, installation by
Pi’s ordinary file tools, independently downloaded upload bytes, exact exported skill bytes, native
discovery, and a fresh SHA-256 challenge at the next turn. The PostgreSQL result matched the daemon
journal. The first canary attempt incorrectly expected internal hash fields in the public upload
response; the corrected probe uses the documented size/download contract and resumed the same
accepted task IDs. No runtime import endpoint was used to install the skill.

## OAuth connection acceptance

The connection callback now returns to `/connections`, consumes only its owner's pending flow,
and distinguishes completion, cancellation, and errors without exposing provider payloads. Mobile
browser checks verified popup opening and closure, account refresh, and disabled unavailable
providers without horizontal overflow. Integrated verification `aa12c2311457` passed after these
changes; it predates the desktop broker integration.

Live discovery verified all six applicable resource metadata endpoints. Linear, Notion, Conductor,
and Sentry each accepted an OAuth start with PKCE and state. An existing consented Linear account
then passed tool discovery and a read-only team lookup through a real V5 Box/Pi task; its result
was checked independently. See [sanitized provider evidence](measurements/plugins-2026-09-07.json).
OAuth starts alone do not prove consent or tool access. Notion, Conductor, and Sentry still need
personal consent for their real-tool checks; GitHub, Slack, and Gmail need deployment OAuth client
configuration. Those paths are not marked accepted.


## Integrated software delivery and deployment recovery

Verification `a68af791c61e` passes on `b4d2741`, including the new PostgreSQL dump/kill/restore
acceptance, executable software builder tests, deferred delivery grants, executor standby during
rolling replacement, and tenant software-build Box-second accounting. A standby process never
claims work before it acquires the existing PostgreSQL advisory lock. The hosted executor returned
to `SUCCESS` and logged `Executor ready` after the rolling-deployment fix.

A fresh V9 Box passed chat, archive/wake with a new post-wake file, and desktop takeover while a
headless task continued. A V10 clean software build then installed the exact Ubuntu `hello` package,
verified its manifest, captured it, and supplied an independent companion and client Box. Pi
executed the installed binary; an independent provider read verified the output file and package
version. The client clone excluded that source workspace. Desktop takeover also passed on this
software-derived companion. Client identity/entitlement used local synthetic fixtures and Mailpit,
so these observations do not claim real email or Stripe acceptance. The source and recipient Boxes
are independent; the build Box was observed archived. See the dated measurement JSON files.

The shared Box account has ten named snapshot slots, seven belonging to existing projects. None of
those seven were changed. Immutable software results currently require a free snapshot slot; a
confirmed quota rejection is terminal and visible, while a lost provider response stays subject to
reconciliation. No automatic fallback to a different image is allowed.
