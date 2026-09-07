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

- Few-second cold creation/wake is not demonstrated: fresh V9 provider creation to ready took about 44 seconds,
  and wake preparation took 16.7 seconds. Phase traces identify service preparation and provider
  hosting as substantial costs; the few-second target remains open.
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
  See `measurements/box-gateway-v12-2026-09-07.json`. V12 deployment remains held for its desktop failure.
- Client activation remains blocked until the model gateway reaches a verified Box distribution.
  The gateway and run-scoped, revocable credentials are implemented; a compiled Linux Pi agent
  completed real GLM calls without a global provider key in its environment. A fresh verified V12
  Box then passed first turn and archive/wake with new file creation. Provider-reported usage
  entered the ledger once, and a completed run's token was rejected before a provider claim.
  The V12 desktop canary failed, so the candidate remains undeployed. The hosted V10
  deployment still uses the previous credential path and must not activate clients.
- V11 distribution publication was rejected during live acceptance: the source contained the
  expected agent SHA-256 immediately after installation, but stop/resume restored the exact V10
  binary; a fresh Box from the named V11 snapshot also contained V10. Provider `ready` did not
  establish artifact integrity. The replacement publication protocol must pin an immutable local
  archive, verify installed bytes and verify every distribution file on a fresh restored Box
  before registration or deployment. The next release uses a fresh source Box. This observation
  does not establish the underlying provider/filesystem cause.
- Full OAuth provider tool/revocation matrix, managed trigger registration, hosted concurrent load,
  real email delivery and Stripe subscription/meter acceptance still lack complete live evidence.
  Software build Box time now enters the existing ledger through fenced observed intervals;
  retries and final partial minutes are covered by PostgreSQL tests.
  A local PostgreSQL 17 dump/kill/restore proof now preserves the authenticated session, durable
  queued turn and retry identity through the real API. The five-service Railway deployment passes
  health, unauthenticated isolation and private MinIO put/get/delete checks, and its replacement
  executor acquired leadership after the previous deployment released it. A PostgreSQL 18 restore
  on the hosted deployment, hosted agent activation and sustained load remain unproven. Personal
  consent and missing settings must not be represented as working connections.

The desktop isolation protects normal product paths and blocks direct headless access to the shared
GUI. A general-purpose GUI can itself open a terminal and launch independent automation. This is not
an absolute security boundary against an agent deliberately building a bypass through the desktop;
no such guarantee should be claimed.
