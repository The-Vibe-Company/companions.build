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
  Production Box adapter integration and a complete live clean-build delivery proof remain open.
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
- Native Pi skill installation is proven through ordinary tools, but dedicated control MCP
  list/install/edit/remove operations from the capability table are absent.
- Full OAuth provider tool/revocation matrix, managed trigger registration, hosted concurrent load,
  real email delivery and Stripe subscription/meter acceptance still lack complete live evidence.
  The five-service Railway deployment passes health, unauthenticated isolation and private MinIO
  put/get/delete checks; hosted agent activation still awaits billing configuration. Personal
  consent and missing settings must not be represented as working connections.

The desktop isolation protects normal product paths and blocks direct headless access to the shared
GUI. A general-purpose GUI can itself open a terminal and launch independent automation. This is not
an absolute security boundary against an agent deliberately building a bypass through the desktop;
no such guarantee should be claimed.
