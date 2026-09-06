# Machine lifecycle, specialist templates and delegation

`lifecycle.ts` persists machine intent separately from chat. `templates.ts` manages owner-scoped
profiles and permissions; `delegation.ts` accepts child or permanent-Companion work atomically.
Only the executor calls `progressLifecycle`. There is no machine contact in API/control handlers.

## Integration

Run `migrateLifecycle(tx)` after product/auth/automation migrations under the existing migration
lock. The production executor creates one `LifecycleCoordinator` and passes it to `tick`.
It starts at most four independent Companion jobs without awaiting their provider calls, so a cold
Box cannot hold warm chat or active task reconciliation. Each job reserves a separate PostgreSQL
connection and fences its effects and checkpoints against the captured leader PID. Pending machines
are polled fairly, with one in-flight job per Companion; shutdown drains jobs before releasing the
leader connection. Direct `progressLifecycle` remains available for deterministic behavior tests. Import `lifecycleControlHandlers` into
`registerControl` after the original delegate and desktop handlers so the durable versions win.
Add `templates`, `template_permission` and `prepare` to the control tool's operation vocabulary.

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
Cross-owner delivery must copy only portable profile data (`name`, `instructions`, `avatar`) and
start from the installation's fresh base Box. Never copy `snapshot_name` or `source_companion_id`.

## Desktop takeover

The executor must block new claims and skip all ordinary Box/daemon contact when `desktop_taken`
is true **or** `desktop_paused_at` is set. Lifecycle processing remains responsible for physical
freeze/thaw. Box runs `systemctl --user freeze/thaw companions-agent.service` through its remote
user bus; local development uses label-checked Docker pause/unpause. The process and its child
tools freeze together. A persisted timestamp appears only after physical confirmation. Closing
the browser does not release takeover. A failed freeze keeps an explicit error and never claims
that the agent has stopped. Box freeze support still requires the live provider canary.

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
the terminal agent outbox as well as active work. The module checkpoints file completion, then
atomically stores the result and creates the parent review task. Results and attachment references
remain attached to the original task after its child retires.

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
late provider response. `python3 scripts/verify.py` runs these with the existing Pi/Linux suite. Live Box freeze, snapshot
and archive validation is left to the isolated credentialed canary; no worktree test uses live keys.
