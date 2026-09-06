# Machine lifecycle, specialist templates and delegation

`lifecycle.ts` persists machine intent separately from chat. `templates.ts` manages owner-scoped
profiles and permissions; `delegation.ts` accepts child or permanent-Companion work atomically.
Only the executor calls `progressLifecycle`. There is no machine contact in API/control handlers.

## Integration

`store.migrate()` applies `lifecycle.sql` in the canonical migration transaction. The production
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
| desktop_takeover / desktop_release | Persist desired physical pause state |

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

The executor must block new claims and skip all ordinary Box/daemon contact when `desktop_taken`
is true **or** `desktop_paused_at` is set. Lifecycle processing remains responsible for physical
freeze/thaw. Box runs `systemctl --user freeze/thaw companions-agent.service` through its remote
user bus; local development uses label-checked Docker pause/unpause. The process and its child
tools freeze together. A persisted timestamp appears only after physical confirmation. Closing
the browser does not release takeover. A failed freeze keeps an explicit error and never claims
that the agent has stopped. A live provider canary confirmed daemon-wide freeze/resume for one Box.

Release thaws the original process and clears the observed timestamp before ordinary journal
reconciliation. An external model request may time out while frozen; that task can fail visibly
when released. It is never replayed. `/runs/:id/suspend` is for a tool already awaiting human input,
and is deliberately not used as a physical desktop pause.

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
physical-pause confirmation, lost snapshot replies, activation checkpoint failure, output durability,
parent review before archive and durable billing delivery. With `RUN_LOCAL_ACCEPTANCE=1`, an actual
owned Linux container proves a subprocess cannot write while paused and resumes after release.
`apps/server/test/async-lifecycle.test.ts` additionally proves that warm chat dispatches and finishes
while another prepare remains blocked, that repeated ticks do not duplicate jobs, that pending
machines share the bounded preparation slots fairly, and that a lost leader cannot checkpoint a
late provider response. `python3 scripts/verify.py` runs these with the existing Pi/Linux suite.
Isolated credentialed canaries have observed live Box freeze/resume, snapshot lookup/re-entry,
archive/wake, and delegated-file handoff on individual Boxes; these observations are not continuous
provider or latency guarantees. No worktree test uses live keys.
