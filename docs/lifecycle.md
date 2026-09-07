# Machine lifecycle, specialist templates and delegation

`lifecycle.ts` persists machine intent separately from chat. `templates.ts` manages owner-scoped
profiles and permissions; `delegation.ts` accepts child or permanent-Companion work atomically.
Only the executor calls `progressLifecycle`. There is no machine contact in API/control handlers.

## Integration

`store.migrate()` applies `lifecycle.sql` and `desktop.sql` in the canonical migration transaction. The production
executor owns one `LifecycleCoordinator`, and `runtime-product.ts` registers
`lifecycleControlHandlers` with the compiled control vocabulary. The coordinator starts at most
four independent Companion jobs without awaiting their provider calls, so a cold Box cannot hold
warm chat or active task reconciliation. Each job reserves a separate PostgreSQL connection and
fences its effects and checkpoints against the captured leader PID. Pending machines are polled
fairly, with one in-flight job per Companion; shutdown drains jobs before releasing leadership.
Direct `progressLifecycle` remains available for deterministic behavior tests.

`handleLifecycle({operation,companionId?,commandId?,runId?,input?}, ownerId)` serves API requests and
MCP commands. API authorization supplies the authenticated owner; callers never accept an arbitrary
owner from request JSON. Operations and payloads:

| Operation | Input |
| --- | --- |
| templates | None; returns only this owner's profiles |
| template_save | name, instructions, avatar; edits also require id and expectedRevision |
| template_permission | templateId, maxChildren (0–20) for this permanent parent |
| spawn | templateId, prompt; commandId is required, runId identifies the parent task when applicable |
| delegate | companionId, prompt; commandId and parent runId are required |
| adopt_template | templateId, childId, expectedRevision, durable commandId |
| prepare / open_desktop | Persist wake intent; no message is created |
| desktop_takeover / desktop_release | Persist desired GUI takeover generation (release requires human authority) |

Creation should set `prepare_requested=true`. Include `snapshot_name`, `template_id` and
`template_revision` in the Companion passed to `prepareBox`, including preparation from a queued
run. Existing Companions retain their original `/home/user/.companions` state path. Template clones
use `/home/user/.companions/agents/<child-id>` so they never open the source Pi journal or history.
A clone keeps its selected template revision and snapshot name even if the profile later changes.
A private snapshot may intentionally retain the owner's browser sessions and installed software.
Cross-owner delivery copies only the portable profile (`name`, `instructions`, `avatar`) plus
bounded, validated local-skill bundles included by the delivery request, and starts from the
installation's fresh base Box. It never copies `snapshot_name`, `source_companion_id`, browser
state, credentials, history, or connections.

## Desktop takeover

Takeover closes only the dedicated GUI broker. Chat, file tools, shell work and ordinary network
requests continue in a separate headless runtime. PostgreSQL stores `desktop_taken`, a monotonic
`desktop_generation`, the observed generation, broker boot ID and confirmed pause timestamp.
Only the authenticated human API can release a taken desktop; MCP cannot grant itself access.
Closing the browser keeps the persisted intent. Late responses cannot overwrite a newer generation.

The broker serializes fixed capture, click, type, keys and scroll primitives. Confirmation follows
abort of an active action, termination of its subprocess group and an X11 input-release roundtrip.
A cancelled or interrupted GUI request is never replayed. Tools return `desktop_paused` promptly,
so the model can continue headless work. Release requires a fresh capture before another action.
Every broker boot is closed until the executor reconciles the durable generation. Periodic checks
also detect broker restarts while idle. Headless run admission never waits for this GUI check.

The broker runs as the desktop user. Pi runs as `companions-agent`, without sudo or capabilities,
inside private mount, PID and network namespaces. It sees only its exact original state path and
an agent-only Unix socket; desktop home, X11 sockets, admin socket and host CDP ports are excluded.
A root-owned TCP proxy exposes the authenticated daemon to the controller. Snapshot/archive remains
blocked during takeover to preserve the human's machine; headless output harvesting continues.

This is a functional boundary for the product tools, not protection against hostile automation
created through GUI applications. A GUI terminal could launch desktop-user code outside the
headless namespace. Pi's brief prohibits that route and requires shell work through headless bash.
The acceptance proof covers the supported tools and blocked direct headless access; it does not
claim containment of every process an adversarial desktop user could create.

Builds install the immutable binary and Linux helpers in `/opt/companions`; wake installs no
dependencies. Existing Boxes require the explicit operator procedure below. A legacy Box without
boundary version 1 retains headless chat but reports an unsupported takeover instead of freezing
its entire daemon or claiming success.

### Existing Box upgrade

Build with `python3 scripts/bun.py scripts/build-agent.ts`. Stop the executor and wait for active
and parked tasks to finish or be explicitly cancelled. With an authenticated owner's private
`.local/session-cookie`, run `python3 scripts/bun.py scripts/upgrade-box-desktop-boundary.ts <id>`.
The script refuses an active executor, active tasks, changed Box identity, or an archived machine.
It pins its private journal/archive, checks leadership before each remote write, stops only owned
services and installs on the same Box. It retains Pi state paths, files and desktop intent; a
completed journal is an idempotent no-op. Restart the executor to reconcile readiness. No request
is replayed. New base snapshots install the same helpers during the existing template build.

Reusing an archived build Box can restart its enabled services. The template builder stops only
its product units, verifies they are inactive, extracts the verified archive into an adjacent
root-owned directory and uses Linux's atomic directory exchange before installation. It never
truncates a running executable. Successful installation removes the exchanged old directory and
legacy `/home/user/.companions-dist` copy, then clears only upload directories associated with that
build Box. Failure retains staging for retry; `/home/user/.companions` and user files are untouched.
The optional `python3 scripts/bun.py scripts/test-template-install.ts` Linux proof covers active
unit refusal, a genuinely mapped old executable, interrupted installation, retry and cleanup.
Systemd responses are fixtures in that test; provider service behavior remains a live canary check.

## Results, adoption and retirement

Spawning locks the permanent parent before counting live children for the selected template.
Children cannot spawn or authorize more children. Delegation between permanent Companions checks
both owners and accepts a background task without blocking the parent's current Pi tool. Results
return asynchronously as another parent background task, avoiding circular waits between agents.

`hooks.filesDurable(run)` must return true only after every declared output has reached durable
object storage. A missing hook or transient failure blocks finalization. The executor must observe
the terminal agent outbox as well as active work. The immutable attachment remains owned by the
child run. The same transaction that creates the parent review inserts owner-scoped
`delegation_files` references, so the parent can stage and download the exact bytes after child
archival without a second object copy.

The child is retained until the parent review finishes, allowing `adopt_template` during review.
A queued/capturing snapshot blocks archive. Snapshot names are persisted before POST; a lost
response is reconciled by GET of that same name, without repeating the capture request. A crash
before POST leaves an uncertain capture that fails visibly after ten minutes; the parent can
request a new capture. Activation uses the expected profile revision and occurs only after provider
readiness. A concurrent profile edit wins; capture never overwrites that edit.

Template activation also records the immutable revision in the same transaction.

After review, durable outputs and pending snapshots are checked before requesting child archive.
The provider is observed until archived; only then is the child soft-retired. No healthy permanent
Box is deleted, replaced or archived by this module. An archive failure retains the child and its
visible error. Rows/results survive retirement. A pending parent review can extend the child's
lifetime; UI should show that it awaits review, rather than reporting it already removed.

## Usage and timing

`machine_usage_events` persists `starting`, `ready` and `archived` timestamps before billing delivery.
`hooks.recordUsage({id,ownerId,companionId,event,at})` retries with the same event ID. Map this to the
billing module as `operationId: 'box:'+id`, `category: 'box_lifecycle'`, `quantity: 1`, `unit: 'event'`,
`occurredAt: at`, `metadata: {event}`. Stripe availability must not affect lifecycle progress.

Provider readiness is variable; Box cold preparation can take roughly 20–90 seconds. These are
operational expectations, not a latency guarantee. Lifecycle stores actual start/ready/archive
boundaries. Preparation has a five-minute bound; retry wakes or repairs the same known Box.

## Verification

`apps/server/test/lifecycle.test.ts` uses isolated PostgreSQL and a fake machine boundary to prove
cross-owner denial, concurrent child limits, identity/revision isolation, no-chat wake,
GUI-pause confirmation, lost snapshot replies, activation checkpoint failure, output durability,
parent review before archive and durable billing delivery. The optional production proof in `experiments/desktop-boundary/README.md` runs the compiled Pi
binary and GUI broker inside an owned Linux container, exercising GUI interruption while chat,
network work and human input continue. It also starts from a partial network setup to prove recovery.
`apps/server/test/async-lifecycle.test.ts` additionally proves that warm chat dispatches and finishes
while another prepare remains blocked, that repeated ticks do not duplicate jobs, that pending
machines share the bounded preparation slots fairly, and that a lost leader cannot checkpoint a
late provider response. `python3 scripts/verify.py` runs these with the existing Pi/Linux suite.
Historical credentialed canaries observed the old whole-daemon freeze/resume, snapshot lookup/re-entry,
archive/wake, and delegated-file handoff on individual Boxes; these observations are not continuous
provider or latency guarantees. No worktree test uses live keys.
