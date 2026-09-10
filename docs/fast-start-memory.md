# Fast-start Companion memory (THE-635)

Each Companion owns its memory under its agent state directory. PostgreSQL remains the web
source of truth; Pi owns native sessions, transcripts, compaction and branches. The memory
service neither moves nor rewrites Pi history. User-scoped memory belongs to this Companion,
not to every Companion owned by that user.

## Startup and tools

Session preparation reads at most 4 KiB from `memory/startup.json`, with a 10 ms deadline,
and includes only unexpired user/Companion preferences and corrections. Missing, malformed,
oversized or unavailable snapshots produce policy-only instructions. Detailed memories and
legacy `workspace/MEMORY.md` are not loaded into the initial prompt.

The daemon starts one lazy child using the same compiled binary's private `--memory-worker`
mode. An explicit memory tool request starts it on demand; otherwise maintenance is scheduled
after a response. SQLite opening, indexing, import and maintenance happen in the child.
The process receives no daemon/provider credentials and exits on parent pipe EOF. Memory
responses use private pipes, not logs. Shutdown stops the owned worker.

`memory_save`, `memory_read`, `memory_search` and `memory_delete` support facts, explicit
preferences/corrections, project setup, procedures and temporary context. The agent selects
categories from natural conversation. Project records require a project key; temporary context
is bound to the execution/mission ID and defaults to 24-hour expiry. It is not automatically
visible to unrelated subsequent runs. Procedures are retrieved on demand rather than installed
as executable Pi skills. No embeddings, automatic LLM consolidation or transcript ingestion runs.

Records use stable IDs and numeric versions. Updates and deletions require the observed version.
Mutation operation IDs and responses are committed with changes (receipts remain for retry safety), so an explicit retry with the
same operation ID and payload observes the original outcome. A changed payload conflicts.
Durable delete retries retain the same payload across executions; temporary deletes explicitly
select the current mission with `temporary=true`. Cancellation or timeout can leave an unknown outcome; the runtime does not replay it.
Search applies project/mission visibility before limiting results and returns up to ten excerpts
of at most 1,000 characters. Bounded fallback scans report `partial=true` when results may be
incomplete. Preparing/unavailable responses
are distinguished from successful empty results. Failed saves never claim success. Tool details
include sanitized elapsed milliseconds and result counts without logging memory content.

The startup snapshot is a bounded, best-effort cache and may lag a committed mutation after an
I/O failure. The current user request and verified evidence take precedence. Durable records
are never automatically deleted to recover a corrupt database; derived search data can be
rebuilt in bounded maintenance batches. The existing `shared_memory_read`/`shared_memory_update`
contract and atomic versioned `MEMORY.md` replacement remain supported. Legacy content has a separate disposable FTS index refreshed from bounded file reads after
atomic replacement; corrupt derived data falls back to the bounded file and rebuilds. Results
identify their source; edit those through the legacy tools. Generic file/shell access remains an
instructed-against same-user bypass, not a separate filesystem security boundary.

Previous-conversation search continues through `companion_control history_search`. It depends
on the existing server connection and searches completed prompts/results. Local structured
memory does not depend on PostgreSQL or that connection.

## Templates and release

Only records explicitly marked reusable project setup or procedures enter the bounded
`workspace/template-memory.json` export. Template publication remains the existing explicit
approval. Capture prefers the active physical state used by desktop-enabled agents and reads
reusable records from the frozen durable store, so a stale export cannot restore revoked reuse. Sanitization and restoration filter this export and remove copied legacy `MEMORY.md`,
including old prepared templates. Future expiry is retained; copied physical stores and migration
checkpoints are cleared while installed root directories remain. The source Companion's files are preserved. New Companions
import validated reusable records with independent IDs; preferences, temporary context, indexes,
receipts and Pi conversations do not transfer through product memory. Other intentionally
copied workspace/browser files retain the existing prepared-disk sharing contract.

Build the distribution before deployment. The memory service is enabled directly in the new
binary and needs no wake-time installation or server/schema migration. An older agent can still
use legacy memory; it cannot retrieve new structured records. Retain the new memory directory
and existing Pi state when rolling back.

## Hermes evaluation

Evaluated [`pi-hermes-memory` 0.9.8](https://github.com/chandra447/pi-hermes-memory), using the
published package already present during the handoff. Its SQLite adapter selects `bun:sqlite`
under Bun; rejecting it solely because its manifest includes `better-sqlite3` would be incorrect.

The reproducible data-only probe inserts a memory, closes/reopens the database and searches FTS5:

```sh
python3 scripts/evaluate-hermes-memory.py --package-dir /path/to/pi-hermes-memory
```

The package must be version 0.9.8 with its dependencies available. For a fresh evaluation,
prepare an isolated temporary npm/Bun project with that exact package; do not add it to the
production distribution or install it during Companion creation/wake. The script creates and
removes its own temporary source, compiled binary and database.

On this Linux x86_64 sandbox with Bun 1.4.2, the probe passed in source mode (22.49 ms) and as a
`bun-linux-x64-baseline` executable (14.54 ms). These are single open/write/reopen/search samples,
not startup distributions or full-extension acceptance.

Source inspection found the extension's `session_start` handler awaits persistence migration/sync,
global/project memory loading, skill migration and recovery maintenance. Its default session
location is also derived from a global agent root, whereas Companion sessions live beneath each
state directory. Adopting the full lifecycle would require changing those behaviors and adapting
our conflict-safe memory and template rules. The internal implementation preserves the existing
Bun/SQLite conventions and gives the daemon an explicit nonblocking boundary. Hermes is not a
production dependency; database compatibility alone does not establish lifecycle compatibility.

## Verification

Focused store/service behavior tests cover persistence, duplicate operations, version conflicts,
isolation, expiry, search degradation, templates, snapshots, cancellation and unavailable workers.
`scripts/test-memory-pi.ts` exercises native Pi compaction and session continuation with the
compiled memory worker inside Docker. Linux daemon acceptance covers lane sharing, restart,
isolated state directories and continued chat during stalled/corrupt preparation.

The latency harness runs at least 30 paired creation/wake samples, alternating baseline/candidate
order. It records daemon readiness, response time and process-start-to-first-response separately.
Wake retains a Pi transcript, legacy memory and 100 candidate structured records. The threshold
is at most 50 ms added p95 process-start-to-first-response latency for both creation and wake.

```sh
python3 scripts/memory-latency.py --baseline /path/to/baseline-distribution \
  --candidate dist/agent --output .artifacts/memory-latency.json
./dev check agent
./dev check full
```

Measurements use scripted responses in Docker Linux; they exclude Box provisioning, network
and real model latency. The harness removes and verifies its owned container after success or
failure. No live Box is required for these deterministic checks.

### Measured creation and wake behavior

On 2026-09-10, 30 paired samples per variant/phase passed the agreed 50 ms threshold:

| Phase | Baseline ready p95 | New ready p95 | Baseline first response p95 | New first response p95 | Added first response p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Creation | 496.41 ms | 450.83 ms | 536.83 ms | 494.83 ms | -42.00 ms |
| Wake | 451.30 ms | 442.97 ms | 492.07 ms | 490.08 ms | -2.00 ms |

Admission-to-response p95 was 45.86 → 49.10 ms for creation and 44.59 → 48.39 ms for wake.
Differences include host/cache scheduling variability and are not a claimed speedup.
The baseline was built before runtime changes from `0ef0032394433d47749669feacc46dc88e288f29`
(distribution `77bd63fe90ce59c1090b701ab92ed58f81e947b5ca1c5bc3d9936d4c44edcbf7`).
Raw paired samples are retained in the ignored `.artifacts/memory-latency-final.json` validation artifact.
Earlier runs also passed (creation deltas -39.98, +8.23 and +0.57 ms; wake +37.80, -0.59 and
-0.51 ms). The table reports the final compiled implementation after review fixes. These repeated
local samples establish the latency threshold in this scripted environment, not a general speedup.

When the host supplies a Git askpass helper, run verification with `env -u GIT_ASKPASS` so
credential-revocation fixtures cannot receive host credentials after the test broker revokes access.
