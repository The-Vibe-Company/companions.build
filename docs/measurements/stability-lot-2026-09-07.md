# Stability lot — September 7, 2026

Runtime and upload changes validated at `4ccd97f` (including `7752fa5` and `ba9f11d`).

- `python3 scripts/verify.py --postgres 18`: **passed**, evidence `89e98f0779cf`.
- Includes frozen dependency installation, TypeScript, agent tests, compiled Linux distribution,
  integrated server tests, web tests/build, authenticated seeded PostgreSQL backup/crash/restore.
- Runtime regressions first failed on `e2c8ff1`: PostgreSQL 40P01 for routine/retirement;
  delegation review left active work on a retired parent; no preparation attempt behind 100
  unresolved retirements. All three pass with the correction, including both review/delete orders.
- Owned verifier containers removed; dedicated focused PostgreSQL container removed.
- Browser upload retry check used synthetic intercepted HTTP responses only: identical file retry
  reused command IDs; changed bytes admitted no additional command; explicit acknowledged Cancel
  cleared the pending upload. No actual message, file, account, Box or provider was mutated.

The existing local app was restarted with the corrected backend after confirming no active or
queued local runs. Its developer services remain available on port 4410. This verification does
not measure live Box startup, production load, external integrations or paid activation.

Frontend integration at `dd86e33`: 78 web tests and TypeScript/production build pass. Browser
checks confirmed same-Companion tab draft retention, cross-Companion Keep/Discard behavior, and
an intercepted Applications mutation failure that displayed an error and retained the server's
selection. A two-step Back scenario additionally revealed a hidden confirmation; its follow-up
regression and final validation are recorded below.

Final frontend follow-up `564b2c1`: all 78 web tests and TypeScript/production build pass. The
authenticated browser now verifies two-step Back, visible confirmation, Keep editing with exact
draft retention, and Discard reaching the original destination discussion. At 390 px there is
one primary navigation and no page overflow. Browser session closed; no identity was saved and
no real application selection changed. The existing Vite bundle-size warning remains open.
