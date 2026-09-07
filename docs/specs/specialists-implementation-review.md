# Specialist implementation review — 7 September 2026

Scope: changes after `39383a2a909db1841c379dcdd3f8db5bd5d98381`, against
[the approved specialist design](specialists-configuration-and-lifecycle.md).
Independent Standards and Spec reviews were followed by fixes and focused regression tests.

## Standards

No remaining blocking violation in the reviewed changes. Cancellation is checked at provider
effect boundaries, including observation followed by snapshot submission. Late create acknowledgements
still record the Box identity for cleanup. Ambiguous lifetime extensions are observed without
repeating their mutation; ambiguous image creation stops before the provider idempotency window ends.
The Git broker keeps credentials in memory and its socket in an owned private temporary directory,
which also works when the agent state is a macOS bind mount into Docker Linux.

One non-blocking design observation remains: `specialist-runtime.ts` contains a substantial state
machine. Its shared operation guard makes cancellation boundaries explicit; extracting individual
states would be reasonable if this orchestration grows further.

## Spec

The reviewed admission, connection, publication and lifecycle blockers are resolved. Limit changes
are serialized with admissions. Team eligibility is rechecked in the admission transaction and
before machine effects. MCP account changes invalidate the draft generation. Publication can reuse
the exact tested image; test completion waits for retained files and confirmed archive. Explicit
capture handoffs can archive their source, while automatic idle archival protects active operations.

Opaque improvements deliberately use assisted reconstruction in the current draft, with human
publication afterward; no general disk merge is claimed. Public preview relay remains deferred.
The new live Box onboarding flow has not been exercised against the provider in this worktree.

## Validation

The complete local verification was started once, then resumed from failed phases after corrections.
Passing unchanged phases were not rerun unnecessarily. The final results across those phases are:

| Check | Result |
| --- | --- |
| Root and web TypeScript | Passed |
| Existing agent/control/desktop unit checks | 140 passed |
| Specialist initialization and Git broker checks | 11 passed; broker checks repeated after the Linux fix |
| Server suites | 363 passed across 53 files, including corrected targeted runs |
| Frontend suites | 137 passed after correcting two stale copy assertions; 51 affected tests rerun |
| Docker specialist disk preservation, cleanup, restore and ignore policy | Passed |
| Linux distribution content proof and compiled agent build | Passed |
| Real Pi Linux acceptance: independent machines, files, cancellation, crash and no replay | Passed |
| Production web build | Passed |
| PostgreSQL 17 dump, crash, restore and integrity verification | Passed |

Local evidence is retained under `.artifacts/verification/`: `c4714b1faa0a` contains the initial
agent and Linux image checks; `f06a0e760fc6` and `85dec28c78e8` contain the server phases;
`64c7709f756c` contains the frontend run; `fb486472f16f` contains the successful final web build
and database recovery. Earlier reports retain the failures that led to the fixes rather than being
rewritten as successful runs. The corrected real Linux acceptance and affected web/Box/Git tests
were run directly afterward.

All owned verification containers, volumes and local acceptance machines were removed and their
absence checked. No live Box was created. Deployment and the live provider canary remain separate
from this local implementation validation.

Review totals: Standards — one non-blocking maintainability observation; Spec — no remaining
blocking finding in the reviewed implementation.
