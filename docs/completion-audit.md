# Completion audit — 7 September 2026

This checklist compares the approved product contract with implementation, independently of green
verification. It does not redefine the approved scope. A checked local path is not provider or
hosted acceptance. See `validation-v0.md` for dated evidence.

## Corrections in progress

- Desktop takeover must keep chat and headless work running. The old daemon freeze did not satisfy
  this. GUI broker, namespace isolation, human-only release, crash fencing and actual Linux/Box
  acceptance pass on Linux and on the owned diagnostic Box. A fresh immutable image still
  needs acceptance; the diagnostic Box required repairs. THE-566 remains open.
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
- Checkout attached only one Price despite separate model/Box meters. Two distinct metered Prices
  now enter Checkout and entitlement checks; integrated activation tests pass. Live Stripe
  acceptance remains. THE-573 was reopened.
- Deliveries omitted the selected model. This is corrected and covered by a PostgreSQL delivery
  check; template revisions and copied specialists also retain their models. Main and specialist deliveries still transport profiles/native skills onto fresh base
  images; they do not reproduce arbitrary installed software from a prepared private snapshot.
  Faithful portable preparation without transferring provider/browser credentials remains open.
  THE-572 was reopened.
- The Account view did not refresh a pending skill delivery while it stayed open. Pending-state
  refresh is implemented.

## Remaining product and acceptance gaps

- Few-second cold creation/wake is not demonstrated: measured preparation was about 19/22 seconds.
  Separate provider and controller timings are needed before choosing the next optimization.
- Chat now uses authenticated SSE invalidation from committed PostgreSQL changes, with durable
  snapshot recovery on reconnect. Full verification and a separate real browser test pass; the
  root development server must be restarted before its final integrated browser check.
- File attachment supports the file chooser and drag-and-drop; the mobile browser drop path is
  checked. Temporary specialists are listed in Team rather than nested beneath the task that launched them.
- Native Pi skill installation is proven through ordinary tools, but dedicated control MCP
  list/install/edit/remove operations from the capability table are absent.
- Full OAuth provider tool/revocation matrix, managed trigger registration, hosted concurrent load,
  real email delivery and Stripe subscription/meter acceptance still lack complete live evidence.
  Missing deployment settings and personal consent must not be represented as working connections.

The desktop isolation protects normal product paths and blocks direct headless access to the shared
GUI. A general-purpose GUI can itself open a terminal and launch independent automation. This is not
an absolute security boundary against an agent deliberately building a bypass through the desktop;
no such guarantee should be claimed.
