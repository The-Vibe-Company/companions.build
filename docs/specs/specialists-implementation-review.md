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


## Pre-PR review and integration follow-up

An independent deep review covered all 73 changed files after integration of the then-current
main. It found seven actionable issues; a targeted review of the subsequent mail integration
found one more. All eight now have inspected fixes:

- Reset inherited GitHub credential helpers before installing the in-memory broker; a real Git
  fill/approve test proves managed tokens are not written to a credential store or reused after revocation.
- Reject new requests during initialization before journal acceptance, including when Pi has
  not yet registered its execution root; retrying the same request later remains valid.
- Open hidden draft conversations with an empty ordinary-companion list, and let phone users
  close/reopen configuration without leaving the chat or losing their edits.
- Expose test conversations while running or failed, separate from the completion assessment.
- Lock configuration during persisted operations and ignore refresh responses that predate local
  edits, preserving the original generation check. Assessment cannot discard an unsaved edit.
- Preserve capacity-form input while polling queued, admitted and cancelling requests.
- Exclude specialist configuration drafts from mailbox activation and incoming email admission,
  so mail cannot bypass a frozen draft or invalidate a tested image without a generation change.

After merging the mail controls from main, full local verification passed with PostgreSQL 18
and storage acceptance enabled (`RUN_STORAGE_ACCEPTANCE=1 python3 scripts/verify.py --profile full --postgres 18`).
This included 396 server tests, 154 frontend tests, real Linux product/MCP/storage acceptance,
compiled runtime and web builds, and PostgreSQL crash/restore. The two final focused corrections
were then checked with 20 mail tests, root TypeScript/runtime build, and all 155 frontend tests
plus the web production build. Earlier failing regression runs are retained as evidence.

Final local evidence: `.artifacts/verification/c49fd7e882d5` (full), `462efafe2b12` (mail),
`446a9b922992` (web). All three record unchanged source during their run and successful owned-resource
cleanup. These checks do not include a live Box canary or deployment.
