# Background agent runtime updates

A deployment can update the runtime on an existing, awake Companion's Box. The Box ID,
workspace, installed user software, Git repositories, Pi sessions and execution journals remain
on that same machine. Automatic updates never fork, replace, archive or resume a machine.
Archived Companions are considered after an ordinary user-requested wake. Published immutable
specialist images are not update targets; this first rollout targets long-lived Companions,
including those created from specialist templates, not temporary missions or configuration drafts.

## Update contract

The build emits `runtime-release.json` with the exact hashes of `companion-agent`,
`photon_rs_bg.wasm` and Pi's `package.json`. Its runtime identity is distinct from the complete
Box image identity. The daemon reads its identity once at startup and reports it through the
authenticated health endpoint. Replacing files must not change the reported running version.

Only these three files and their manifest are automatically replaced. Linux launchers, desktop
services, OS packages and user-installed software are retained. The installer copies the existing
platform directory, replaces the exact runtime files in that copy, and exchanges the directories
atomically. It keeps the previous directory for rollback; it never restores an old user disk.
Protocol and persisted-state epoch 1 is the backwards-compatible update channel. A change that
requires incompatible journal migrations, desktop protocol changes, OS changes or new launcher
features must use a separate explicit migration; it must not be released as an epoch-1 runtime.

## Scheduling and recovery

The executor's existing per-Companion lifecycle job owns updates. PostgreSQL records each update
UUID, target release, Box identity, installer hash and phase before external effects. One update
is admitted globally at a time. Update admission and run admission lock the same Companion row.
Messages and routines are still persisted while maintenance prevents dispatch; their request IDs
are retained. Other Companions continue running without an executor restart.

Running/preparing requests, parked questions, desktop takeover, pending capture and machine
operations defer maintenance. Before replacement, the installer freezes the owned agent service
and checks its processes and ephemeral mounts. Unexpected background processes or temporary user
files defer the update, with no deletion and no service restart. This is intentional: an idle chat
is not proof that restarting its shell environment would preserve every user's work. There is no
forced automatic cancellation or cleanup to make an update eligible.

For a daemon that supports maintenance, admission is drained before installation. Legacy agents
are eligible only if the installer recognizes their existing isolated service layout and confirms
its safety checks. The GUI broker is not restarted. The new daemon must report the expected
runtime identity and be healthy before dispatch resumes. Failed startup rolls back only runtime
files, and the old daemon must be healthy before new messages can run. A confirmed rollback stops
further attempts for that target release. New releases may be considered later.

An unknown install result remains blocked. Subsequent ticks inspect the same remote journal and
reconcile observed files/service state; they do not replay the install or any user prompt. A missing
journal after an ambiguous apply is not proof that the command was never received. Queued messages
remain visible and undispatched until recovery is confirmed. Recovery checks are throttled; busy
or unsafe Companions are reconsidered after five minutes. Old releases and upload staging are
retained intentionally; garbage collection is a separate operation with its own retention policy.

## User experience

The Activity indicator reports the persisted `updating` or `blocked` state and explains that new
messages are saved. Deferred updates leave normal work available. A manual force-update button is
not part of this release: it would require an explicit interaction for active work and ephemeral
data. Normal compatible updates require no user action.

## First deployment and rollback

Build the complete distribution and run full verification before deployment. For the first
rollout, stop the old executor and wait for leadership release before starting the new executor:
the old version does not respect the new update admission fence. Apply `runtime-updates.sql`
through the canonical migration command and deploy API, worker and executor from the same source.
Keep active Companion tasks and their durable request IDs; do not restart their Boxes as part of
the Railway rollout. Existing work finishes before background update admission.

Do not downgrade the executor while any `runtime_updates.finished_at IS NULL` rows exist. Keep
the updated executor until those updates are confirmed complete or safely rolled back. If an
update is blocked, inspect its fixed error code and private root-owned remote journal before any
operator action; never clear the dispatch fence merely to unblock the UI. Retain additive database
columns on rollback. Keep a compatible API available for queue persistence throughout maintenance.

## Verification

PostgreSQL behavior tests cover idle admission, running/parked work deferral, retained queued
messages, one-Box identity, lost apply responses, unknown outcomes, rollback and archived-machine
exclusion. Agent tests cover maintenance rejection without accepting a request ID, parked work,
and reading prior request history while drained. Python installer behavior tests exercise
filesystem preservation, atomic replacement, interruption/reconciliation, rollback, checksums,
symlinks and process/ephemeral-data guards. Header interaction tests use persisted update states.
A live Box upgrade is a separate acceptance check; deterministic tests do not establish a hosted
rollout or permission to upgrade the production Design Companion during PR preparation.
