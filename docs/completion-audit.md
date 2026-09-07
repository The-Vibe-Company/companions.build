# Completion audit — 7 September 2026

This checklist compares the approved product contract with implementation, independently of green
verification. It does not redefine the approved scope. A checked local path is not provider or
hosted acceptance. See `validation-v0.md` for dated evidence.

## Corrections in progress

- Desktop takeover must keep chat and headless work running. The old daemon freeze did not satisfy
  this. GUI broker, namespace isolation, human-only release, crash fencing and actual Linux/Box
  acceptance pass on Linux and on a fresh immutable V9 Box. The fresh Box also writes new files
  after archive/wake and completes headless work during desktop takeover without manual repair.
  See `measurements/box-v9-2026-09-07.json`.
- Permanent creation from a pinned template was missing even though temporary specialists worked.
  The shared store and control operation now copy a chosen revision with fresh identity; PostgreSQL
  isolation/pinning tests, API/UI integration and full verification pass. Creation retries now
  preserve the original revision and identity after a lost response. THE-574.
- Custom MCP web configuration exposed only a label and HTTP URL despite backend support for
  headers, stdio arguments and environment. The compact form now supports headers, stdio arguments and secret environment values; mobile
  interaction and full verification pass.
- Existing plugin connections had no explicit read-only check or visible expired-access path.
  Safe provider verification and a status projection are implemented and verified in the browser. Custom stdio must never run
  in the API process. Real OAuth/provider acceptance remains incomplete. THE-564 stays open.
- Checkout omitted the fixed subscription and separate model/Box meters. One fixed recurring Price
  and two distinct metered Prices now enter Checkout and entitlement checks; activation tests pass. Live Stripe
  acceptance remains. THE-573 was reopened.
- Deliveries omitted the selected model. This is corrected and covered by a PostgreSQL delivery
  check; template revisions and copied specialists also retain their models. Main and specialist deliveries still transport profiles/native skills onto fresh base
  images; they do not reproduce arbitrary installed software from a prepared private snapshot.
  A typed manifest and clean Linux reconstruction foundation now passes artifact integrity and
  isolation tests. Signed APT and integrity-pinned npm resolution, durable build coordination, immutable software
  results, recipient grants and pending delivery gates are implemented and locally verified.
  The production adapter is integrated. A real Box built, verified and captured the pinned
  public package; a new Pi companion executed it, and an independently granted recipient Box
  retained the tool without the source workspace. See `measurements/software-box-v10-2026-09-07.json`.
  Recipient auth/billing were synthetic local fixtures; live commercial activation remains open.
  THE-572 was reopened.
- The Account view did not refresh a pending skill delivery while it stayed open. Pending-state
  refresh is implemented.

## Remaining product and acceptance gaps

- Few-second cold creation/wake is not demonstrated. The latest fresh V12 sample prepared in
  10.5 seconds; wake preparation took 16.4 seconds. Initial viewer provisioning exceeded the
  60-second canary deadline and later recovered without manual repair. Real browser control then
  opened the system settings with mouse/keyboard. See `measurements/box-gateway-v12-2026-09-07.json`.
- A traced wake prepared in 16.747 seconds: about 8.7 seconds until provider readiness,
  4.647 seconds in the service command (only 182 ms measured inside the services), and
  1.884 seconds publishing the port. A preview-rediscovery experiment failed its first health
  probe and prepared in 33.42 seconds; it was reverted rather than shipped. Single samples
  do not establish a causal slowdown magnitude. See `measurements/box-v12-wake-trace-2026-09-07.json`
  and `measurements/box-v12-rediscovery-experiment-2026-09-07.json`.
- The traced wake again exceeded the desktop provisioning deadline. A read-only observation
  found the viewer packages installed, x11vnc running and novnc inactive; a subsequent wake
  passed desktop acceptance without manual repair. The cause of that intermittent service
  readiness remains unresolved. All owned test Boxes were archived after validation, and the
  local stack/tunnel stopped: `measurements/test-resource-shutdown-2026-09-07.json`.
- Real V12 main/background execution through the model gateway passes: a manual invocation of a
  disabled routine ran for 43.8 seconds while chat completed in 4.8 seconds, 29.6 seconds before the
  background task. Its independent file and all 3 provider ledger entries were verified; the routine
  was removed. This is not a clock-fired or sustained-load proof. See
  `measurements/routine-chat-gateway-v12-2026-09-07.json`.
- A real clock-fired V12 routine also passes: admission at the scheduled UTC instant +384 ms,
  a real GLM response after 5.3 seconds, exactly one occurrence and one provider ledger entry.
  The fixture was disabled and removed; completed-journal recovery creates no new work. See
  `measurements/routine-clock-v12-2026-09-07.json`. Sustained scheduling remains unproven.
- Scheduler recovery now includes actual Bun process termination around the PostgreSQL occurrence
  checkpoint: incomplete admission rolls back, and committed admission retains one run after restart.
  See `measurements/routine-process-recovery-2026-09-07.json`. This uses a fixed schedule instant.
- Chat now uses authenticated SSE invalidation from committed PostgreSQL changes, with durable
  snapshot recovery on reconnect. Full verification and a separate real browser test pass; the
  root browser also observed committed changes after reconnect without polling.
- File attachment supports the file chooser and drag-and-drop; the mobile browser drop path is
  checked. Temporary specialists now appear under their originating chat/background task; retired
  specialist transcripts are read-only and labelled Finished. Mobile fixture navigation is checked.
- Native Pi skill installation is proven through ordinary tools. Dedicated control MCP
  list/install/edit/remove operations now wrap the bounded local Pi package helpers, use stable
  command IDs and compare-and-swap hashes, and pass local filesystem and Linux binary tests. They
  pass live acceptance on an independently verified V12 image: duplicate installation operation,
  exact exported bytes, daemon journal and discovery/use on the following turn are checked.
  See `measurements/box-gateway-v12-2026-09-07.json`. Its first viewer attempt timed out during provider provisioning; the same Box later passed without manual repair.
- Model credential isolation now passes real Linux and V12 Box acceptance. No global model key is
  present in the Box configuration or daemon environment. Verified provider usage enters the ledger
  once, and completed-run access is rejected before a provider claim. The gateway is deployed at
  application commit `7834b7e`; inspection verifies the provider key on the API only, a key-free
  executor and the registered V12 software base. Commercial activation still requires real Stripe
  settings and end-to-end billing acceptance. See `measurements/hosted-gateway-2026-09-07.json`.
- V11 publication was rejected after the source's installed V11 binary reverted to V10 on
  stop/resume and a named-snapshot restore. The replacement publisher pins an immutable archive,
  checks installed bytes and verifies all distribution files on an independent restored Box before
  registration. A fresh source V12 passed this protocol and live acceptance. The V11 capture was
  retired; the underlying provider/filesystem cause was not established.
- Full OAuth provider tool/revocation matrix, managed trigger registration, hosted concurrent load,
  real email delivery and Stripe subscription/meter acceptance still lack complete live evidence.
  Software build Box time now enters the existing ledger through fenced observed intervals;
  retries and final partial minutes are covered by PostgreSQL tests.
  A local PostgreSQL 17 dump/kill/restore proof now preserves the authenticated session, durable
  queued turn and retry identity through the real API. The five-service Railway deployment passes
  health, unauthenticated isolation and private MinIO put/get/delete checks, and its replacement
  executor acquired leadership after the previous deployment released it. A read-only dump of hosted
  PostgreSQL 18.6 also restores into an isolated local 18.6 container with matching archive SHA,
  schema, constraints and selected V12 base. That hosted snapshot contains no tenant/job rows. A separate populated local PostgreSQL 18.6
  recovery now proves Better Auth session continuity and Companion/message retry identity, including
  exact request-scoped row counts. The integrated suite passes in 45.4 seconds. See
  `measurements/hosted-postgres18-restore-2026-09-07.json` and
  `measurements/local-postgres18-routines-2026-09-07.json`. Production-sized recovery remains unproven.
  Hosted agent activation and sustained load remain unproven. Personal consent and missing settings
  must not be represented as working connections.

The desktop isolation protects normal product paths and blocks direct headless access to the shared
GUI. A general-purpose GUI can itself open a terminal and launch independent automation. This is not
an absolute security boundary against an agent deliberately building a bypass through the desktop;
no such guarantee should be claimed.
