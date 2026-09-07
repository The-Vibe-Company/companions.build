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

Each companion follows the reference header: identity on the left; Team with allowed profile
avatars/count, Automations with enabled count/next scheduled fire, and Activity with actual state
on the right, followed by a circular Settings action. Missing summaries stay absent instead of
showing invented counts. Clicking the identity returns to Discussion. Apps and Computer remain
accessible in Settings; Apps also has a workspace rail entry. URL history and direct links keep
their existing meanings. Narrow screens scroll the control row. There are no nested tabs.

## Main surfaces

The discussion uses aligned avatar/content rows for both participants, with author and time on
one line. Markdown, streamed output, attachments, questions, task links and cancellation remain
functional. The composer is a white rounded rectangle with a circular send action.

Settings places identity and Save together, with the avatar pencil revealing appearance controls, then granted
application accounts, computer/model and client delivery, and deletion. Appearance and model
changes belong to one form. Dirty fields survive section changes and exits require a deliberate
discard; only changed fields are patched. Applications and Computer keep their direct URLs. Client delivery is visible inline.

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

The Create screen uses a 440px preview column and 200px character on desktop, 64px form insets,
two equal identity fields, three account columns and inline Create/Advanced actions. Six main
swatches and outline silhouettes match the reference; extra colors and expressions remain in a
small disclosure. Mobile stacks the panels and preserves 44px interaction targets.

### Reference fidelity verification — 2026-09-07

Compared the supplied HTML reference and authenticated local UI at 1440×900: Discussion header,
Create, Settings, and Specialists (including inline editor). Checked 390×844 responsive layouts
and header access without document overflow. Saved drafts, guarded exits, creation retry and
account grants remain covered by the web suite: 124 tests passed with one worker. Production
web build passed. Reference fixtures were not copied into product data; profile-level account
grants and usage statuses remain absent where the API does not provide them. No Box was launched.
