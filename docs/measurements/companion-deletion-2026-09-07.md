# Companion deletion — 7 September 2026

The settings overview exposes Delete companion. The confirmation names the companion,
explains removal of its temporary specialists and stopping automations/computers, and keeps
shared profiles and connected accounts. Keep companion receives initial focus. Escape goes
back to settings. Pending deletion disables repeat submission and closing; errors remain
visible and the same companion can be retried. Accepted deletion returns home and removes
returned companion IDs from navigation, including stale list responses.

The operation removes companions from the workspace, not their retained database history or
files. Machine archive is asynchronous and owned by the executor. This is not a data-erasure
or immediate provider-stop guarantee.

Frontend verification: 66 tests passed, including confirmation, failure/retry, pending request
protection and return-home behavior. TypeScript and production build passed. The confirmation
was inspected manually at 390px: no horizontal overflow, Keep companion focused, Escape
returned to settings. No existing companion was deleted during that inspection. Screenshot:
private `.local/delete-confirm-mobile.png`.

Initial integrated backend validation: full isolated PostgreSQL 18, Linux runtime, server,
frontend, database crash and restore suite passed (`1d871d9b2b10`). This run includes the
owner retirement endpoint, archive progression and local missing-container detection.

Authenticated local browser canary: created a disposable companion with `prepare:false`,
confirmed deletion in Settings, returned to `/`, and verified absence from the list.
Repeating DELETE returned 202. The retained row has retired_at and archived_at, status
archived, no Box ID, no preparation request and zero runs. No test machine was started.

This canary caught PostgreSQL microsecond precision being lost when a retirement checkpoint
was compared through a JavaScript Date. The checkpoint now carries the exact database text
token. After restarting the local server with the correction, the retained canary reached
archived without an error. Earlier full-suite success alone did not cover that new path.

Final verification: full PostgreSQL 18/Linux/recovery suite passed (`bfa6c85a9207`),
including all nine retirement tests and the regression where deletion wins during snapshot
observation. Focused retirement and existing snapshot tests cover 62 assertions.
After the requested navigation adjustment, 66 frontend tests and the production build pass.
The header gear is removed; Settings beside Discussion/Automations/Team opens the same
settings directory with personality, applications, client delivery, activity, Box computer
access and deletion. Browser verification at 320px found no horizontal overflow and confirmed
the directory opens directly. Retained retired companion histories are read-only.

The local stack was restarted with the completed backend. Owned verification containers and
browser sessions were cleaned up; the requested development stack remains running on 4410.
