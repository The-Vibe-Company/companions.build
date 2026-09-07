# companions.build interface

The visual reference is the owner-provided **Companions.build design système** archive,
`Companions.dc.html`, retained direction 4a (Discussion, Settings, Create and Specialists).
Its example people, accounts, statuses and counts are illustrations, not application data.

## Foundation

- Light ivory canvas `oklch(.988 .003 95)`; rail `oklch(.97 .005 95)`.
- Ink `oklch(.255 .008 120)`; muted text `oklch(.49 .009 100)`.
- White account tiles, quiet borders `oklch(.925 .004 95)`, input borders
  `oklch(.855 .006 95)`. Companion colors provide the expressive palette.
- Inter, restrained fixed sizes, generous whitespace. Primary actions use dark ink.
- Avatars retain their persisted eight shapes, eleven colors and five expressions. A padded
  SVG view box, rounded dark outline and dot eyes with highlights give them the sticker treatment.
  Sleeping is a presentation of persisted lifecycle state, not a stored appearance change.

## Navigation

The desktop rail is 96px wide: home, companion avatars with persisted status, creation,
Specialists, Apps and account access. Names remain accessible and appear as native hover titles.
On mobile the rail opens from the menu and has an explicit close control and backdrop.

Each companion has one row of pill controls: Discussion, Team, Automations, Activity, Apps,
Computer when available, and Settings. The row scrolls on narrow screens and reveals the current
section after navigation or a resize. The identity retains its shortcut to Settings. URL history
and direct links keep their existing meanings. There are no tabs inside Settings.

## Main surfaces

The discussion uses aligned avatar/content rows for both participants, with author and time on
one line. Markdown, streamed output, attachments, questions, task links and cancellation remain
functional. The composer is a white rounded rectangle with a circular send action.

Settings places identity and Save together, then a compact appearance disclosure, granted
application accounts, computer/model and client delivery, and deletion. Appearance and model
changes belong to one form. Dirty fields survive section changes and exits require a deliberate
discard; only changed fields are patched. Applications can also be opened directly in the header.

Application tiles group real connected accounts by provider. Each account grants access separately.
Writes are serialized and the persisted selection is re-read after both success and failure;
superseded responses cannot replace a newer acknowledged state. Connection setup remains in Apps.

Specialists is the reusable profile library. Profile revisions, edits and restores use the existing
API; running status and usage counts are shown only where the backing projection exists. Runtime
specialists and their tasks stay in each companion’s Team and Activity surfaces.

Creation is a full split view: a live character preview and appearance choices on the left,
identity, connected accounts and specialist choices on the right. Mobile folds appearance controls
behind a single disclosure. `/new` is directly accessible. Creation persists one owner-scoped
session intent, creates with `prepare:false`, then grants the selected accounts and specialists.
Retries resume that intent. The user can open an already-created companion and finish optional
access setup later if an account is no longer available. Chat sending remains the wake action.

## Validation

Check desktop and narrow mobile sizes, keyboard navigation, focus visibility, long names and
purposes, multiple accounts of one provider, loading/error states, unsaved forms and reduced motion.
Visual work never needs to start a Box. Local preview and browser artifacts stay private in `.local`.
Behavior coverage should protect grants, drafts, version conflicts and partial setup recovery rather
than assert the exact CSS structure of a screenshot.
