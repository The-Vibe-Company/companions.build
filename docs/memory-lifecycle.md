# Companion memory lifecycle

This extends [fast-start memory](fast-start-memory.md). The existing SQLite store and private
worker protocol remain the only record store and memory protocol. PostgreSQL stores human
commands and compact delivery receipts; receipt responses contain status and record identifiers,
not record bodies. Intent payloads use canonical base64-encoded JSON because PostgreSQL JSONB
cannot represent U+0000 in a preserved legacy file. The agent receives the original protocol request. Pi owns native
sessions, transcripts, branches, compaction and `continueRecent` exactly as before.

## Records and retrieval

A record retains its stable `id`, numeric `version`, `content`, `kind`, `provenance`, timestamps,
project/mission identity and reusable flag. Lifecycle metadata adds:

| Field | Meaning |
| --- | --- |
| `status` | `active`, `superseded`, or `retired` |
| `approval` | `approved` or `pending`; pending records are proposals |
| `assertedAt` | When this assertion was recorded |
| `reviewAfter` | Optional time to review the source; not an extension of expiry |
| `expiresAt` | Optional absolute expiry; context and mission records default to 24 hours |
| `source` | `{ type: "run" \| "ticket" \| "pr" \| "repository", ref, revision? }` |
| `scope` | `global`, `project`, `mission`, or `conversation`; legacy `user` and `companion` remain supported |
| `supersedes`, `supersededBy` | Stable record IDs connecting replacement history |
| `verification` | `verified`, `changed`, or `missing` when checked |
| `mission` | Ticket, Workspace, optional PR and `pr_merged` / `work_completed` stop condition |
| `structured` | A product thread checkpoint with `decided`, `open`, `next`, and `pointers` |

All global/user/companion scopes still belong to this individual Companion, never every
Companion in an account. Project, mission and conversation retrieval requires the corresponding
identity. Read and search return only visible, active, approved, unexpired records whose source
has not failed verification. Inspection deliberately returns proposals and history with their
status. Retrieval always includes provenance; a remembered action is never evidence that the
external action completed. Agent instructions require a fresh source check before irreversible
actions and before reporting external completion.

Saving a replacement names `supersedes: [{ id, expectedVersion }]`. Replacement and retirement
of its predecessors are atomic and version checked. A pending proposal does not supersede its
predecessors until the human approves it. Retired and superseded records cannot be revived by
ordinary saves. Retirement preserves content and links; deletion remains an explicit operation.
Operation IDs retain their original payload and receipt across retries. Reusing an ID with a
different request conflicts. Expiry excludes a record immediately; later maintenance marks it
retired without deleting its history.

## Write policies and legacy memory

Automatic active writes are limited to context and reversible project facts. Preferences,
corrections, procedures, global facts and decisions are proposals. `uncertain: true` always
requires approval. A human approves the exact observed record version through the authenticated
API or Memory settings; agent tool arguments cannot grant human authority. Category selection
and recognizing ambiguity still depend on the agent following its instructions: this release
does not claim a semantic classifier capable of detecting a decision disguised as a fact.

Repository knowledge is represented by a repository path pointer. The store derives its display
content from the path instead of accepting an independently authored restatement, and captures
a bounded source revision when available. Source pointers are advisory data, never executable
instructions. No embeddings, transcript ingestion or automatic LLM consolidation is introduced.

Existing records without lifecycle metadata remain active and approved, with their original
expiry (or none). The effective asserted time is the original creation time; legacy provenance
is clearly marked as legacy source information. Opening the store adds metadata tables but does
not rewrite old rows. Existing over-budget databases remain readable and require explicit
consolidation before additional growth.

`MEMORY.md` remains readable with its content hash version and 30,000-byte bound. New-runtime
`shared_memory_update` returns a proposed replacement and its observed version; it no longer
silently accumulates durable prose. A human can submit that replacement through the memory API. Approved replacements advance an
adopted legacy record's numeric lifecycle version exactly once with their receipt. Out-of-band
file changes prevent a stale retirement until an explicit replacement reconciles the new bytes.
The existing file replacement primitive retains atomic rename and version conflict behavior.
A durable intent precedes file replacement. Recovery acknowledges the intended content only if
its hash is present; any other ambiguous outcome conflicts instead of replaying the replacement.

`adopt-legacy` attaches lifecycle metadata to the legacy file in the same store without rewriting
its bytes. Retirement can then hide it from current structured retrieval while preserving the
file. The low-level file read remains available for inspection; the runtime legacy read tool also
hides retired content and returns lifecycle provenance. Legacy content is treated as
unverified historical context, not proof or a substitute for approval.

## Mission closure

A new mission record binds its ticket, Workspace, optional PR, and stop condition. Mission
records default to 24-hour expiry even when their category is durable; updates preserve the
original deadline unless explicitly changed. Prefer
canonical `https://github.com/owner/repo/pull/N` PR pointers. `pr_merged` closes only when its bound
PR merges and requires that PR pointer at save time; use `work_completed` while the PR is
unknown. `work_completed` closes only when its tracked ticket/run finishes. The creating run or
an unrelated ticket/PR cannot satisfy the other stop condition. The existing GitHub webhook handler
verifies the signature and commits the delivery and a memory observation command in the same
PostgreSQL transaction. A closed, merged PR queues retirement even if the trigger's agent-work
filter would reject the event. No extra agent run is needed.

The executor delivers pending memory commands only to already-ready machines. It also performs
bounded source checks of active mission pages: GitHub PR/issue state, Linear issue state, and
owned persisted run state. Provider checks use an unambiguous selected account, fixed provider
hosts, no redirects, a two-second deadline and a 64 KiB response bound. Provider credentials and
payloads do not enter memory records or diagnostics. Multiple selected provider accounts,
missing credentials, unavailable sources and unsupported pointers leave source verification
unavailable; they are never interpreted as completed work.

A completion observation retires matching missions and records a completion tombstone. Future
saves or approvals cannot silently recreate active memory for that completed source. A lost
worker acknowledgement leaves the identical command pending; its durable memory receipt
resolves delivery without launching or replaying an agent.

Closure is asynchronous. New GitHub trigger registrations subscribe to both failed-CI
`workflow_run` and lifecycle `pull_request` events, while PR events never launch a CI agent run.
Re-register pre-existing GitHub hooks to add the lifecycle subscription; polling remains the
fallback until then. Polling covers supported pointers when credentials are selected. The
coordinator begins after readiness, visits one ready Companion per scheduling pass, and observes
a Companion at most once per 30 seconds, five records per page. Sleeping/old/unreachable agents
are not woken for memory; their queued changes apply when a compatible runtime is ready. No
offline process can know about a merge it has not observed. Until then, source re-verification
remains mandatory for action, and the UI does not claim a queued retirement has completed.

## Budgets and grooming

Each scope has an active/proposal cap of 100 records and 128 KiB of content. The whole store has
a retained cap of 500 records and 512 KiB of content, including retired and superseded records.
At a cap, saves return `consolidation_required` rather than evicting arbitrary memories. Use an
atomic superseding replacement, retire obsolete records, or explicitly delete retained history
when the retained cap is reached. Mutation receipts remain for retry safety and are not pruned.

Repository grooming runs only in the child worker after responses, never during Companion
creation, session setup or the first response. The normal daemon entry point does not initialize
the memory-worker module; only the private worker process imports it. Each pass visits at most ten repository records
and reads at most 64 KiB. Changed or missing sources are flagged and excluded from current
retrieval. Work rotates across records; it does not recursively consolidate with a model.
The daemon can close/kill its owned worker; source polling observes cancellation between bounded
requests. Unavailable memory remains non-fatal and returns preparing/unavailable rather than a
successful empty result. The startup snapshot keeps the existing 4 KiB / 10 ms boundary and
filters inactive, unapproved, expired and failed-source entries.

## Thread checkpoints and human API

`memory_checkpoint` closes a product thread with bounded arrays of decisions, open questions,
next actions and source pointers. The checkpoint is an ephemeral structured memory record;
it does not convert its decisions into approved durable preferences. `memory_brief` retrieves
the current checkpoint and pointers for a follow-up thread. A thread closes once; retries use
the same operation ID, and a new thread uses a new thread ID. Neither operation touches
Pi entries or changes native continuation. No full transcript is ingested or copied.

All routes below require the owning user's session:

| Route under `/api/companions/:id/memory` | Behavior |
| --- | --- |
| `GET /?cursor=…` | Inspect up to five records with a 64 KiB target page budget, including status/provenance and `nextCursor` |
| `POST /approve` | Queue `{ operationId, id, expectedVersion }` approval |
| `POST /retire` | Queue `{ operationId, id, expectedVersion }` retirement |
| `POST /adopt-legacy` | Queue `{ operationId }` metadata adoption without changing the file |
| `POST /legacy` | Queue `{ operationId, expectedVersion, content }` approved legacy replacement |
| `POST /checkpoint` | Queue `{ operationId, threadId, projectKey?, decided, open, next, pointers }` |
| `GET /brief?threadId=…&projectKey=…` | Read a structured brief |
| `GET /commands/:operationId` | Read persisted application status and response |

Mutations return `202` with the persisted command, not a claim that the memory changed. Read
routes never wake a machine. A single large record is returned alone when it exceeds the list-page budget, including a
legacy file whose preserved 30,000 bytes expand under JSON escaping; transport replies remain capped at 256 KiB. Settings → Memory provides explicit inspection, pagination,
provenance, legacy metadata adoption, proposal approval and retirement with pending/error states. A full memory editor,
legacy replacement editor, source-account picker and checkpoint composition UI are deferred;
the API provides those record-level operations without changing chat navigation.

## Deployment and validation

Build the agent distribution before deployment, apply the additive PostgreSQL migration, and
deploy API/executor plus the new runtime. An old runtime returns unavailable for the new route;
commands remain pending and ordinary conversation continues. Keep SQLite lifecycle tables,
completion tombstones, mutation receipts, legacy files and all Pi data on rollback. Older
binaries do not enforce the new lifecycle filters, so rolling back the agent also rolls back
these protections; do not advertise lifecycle enforcement while old agents are running.

Template export filters active, approved, unexpired reusable setup/procedures from the frozen
store, including lifecycle metadata when a derived export is stale. Private memory, legacy
files, proposals, completion receipts and native Pi history do not transfer.

Focused store, service, server and UI tests cover filtering, transitions, budgets, source change,
legacy compatibility, policies, durable merge delivery and honest pending states. The Docker Pi
fixture closes a product checkpoint, checks unchanged native entries, compacts, and continues
the same session. Run `./dev check agent`, `./dev check server --test memory`, `./dev check web`
and `env -u GIT_ASKPASS ./dev check full`. The paired latency harness compares 30 creation/wake
samples per variant against a pre-change compiled distribution; its synthetic records fit the
new scope budget. It excludes provisioning, network and live-model latency.

Source integrations use the provider-owned [GitHub pull request API](https://docs.github.com/en/rest/pulls/pulls)
and [Linear GraphQL API](https://linear.app/developers/graphql). Tests use synthetic provider
responses; they do not claim a live provider canary.
