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
