# companions.build — interface reference

The visual reference is a calm, near-monochrome product in the spirit of DeepSeek Harness:
neutral surfaces, one system typeface, a single blue accent, hairline separators and light/dark
parity. It replaces the earlier warm “Atelier” direction. Product decisions remain in
[companions-build.md](companions-build.md); the current implementation boundary is in
[v0.md](v0.md).

Reference fixtures in tests illustrate layout only. They are not production data and never
represent a persisted state the API did not return.

## Foundation

- One token system: `apps/web/src/styles/tokens.css`. Semantic surfaces (`--bg-base`,
  `--bg-sidebar`, `--bg-layer-1/2`), lines (`--border-l1/l2`), text (`--label-primary/secondary/
  tertiary`), one brand blue (`--brand`) and status colours. `[data-theme="dark"]` restates them;
  no component introduces a second palette.
- Light canvas is white with a `#f9fafb` rail; dark is `#151517` with a `#1b1b1c` rail.
- System sans for everything (`--font-sans`); no webfonts and no serif headings. Code uses
  `--font-mono`.
- The blue accent is reserved for links, focus rings and a selected control. Hover and selected
  nav states use a neutral tint derived from the ink colour, so both themes stay quiet.
- Radius 6/8/12 (pills only for tags and status). Depth is a hairline; `--shadow-menu` is the only
  shadow and belongs to menus, sheets and the mobile drawer.
- Motion keeps the existing 120/150/200 ms rhythm and honours `prefers-reduced-motion`.

## Avatars

- `CompanionAvatar` renders the persisted shape/colour/face at normalised sizes; the expressive
  avatar is the only place colour is allowed.
- `AvatarStack` overlaps up to three faces with a `--surface-ring` ring, then a `+n` chip. It marks
  a team chat in the rail and the participant group in the header.

## Navigation and conversations

- One rail, one list. Team chats and direct conversations share a single recency-ordered list;
  there are no folders and no separate companion roster. A direct conversation is a normal row
  named after its Companion; a team chat shows an `AvatarStack`.
- Row grammar: mark, title over last-message preview, time. Row actions (rename, companion
  settings, archive) live in the row menu, reached by its trigger or a right click.
- The header `+` opens create: **New team chat** (participants first), **Message <Companion>**, or
  **New companion**. The `···` menu holds archived conversations and the theme switch. Archived
  conversations open in a focus-trapped sheet and restore in place.
- Each row states only persisted facts: the last message and its time, or “No messages yet”.

## Conversation

- The header is one row: the participant stack, the renameable title, a `+` that adds a Companion
  directly, and a single **Workspace** button. Adding a companion no longer hides in a modal.
- The timeline carries only the conversation: day separators, grouped messages, one line per active
  run, open questions, and pending invitations. A coordinator invitation is a compact inline event
  with Accept/Decline.
- The composer is one row: optional recipient pill (only when a target or team exists), attach,
  text, send. `@` addresses a specific Companion; direct conversations have no recipient control.
- Every state comes from `tasks`/`centralRuns`/messages; nothing is simulated.

## Conversation workspace

- One right-hand panel, opened by the **Workspace** button, with tabs **Files**, **Computers** and
  **Details**; selecting a Companion opens that Companion's Results/Files/Computer/Configuration
  views. Details carries participants and archive, so there is no separate details modal.
- On narrow screens the panel replaces the timeline and a bottom bar offers Thread, Files, Details
  and a participant picker.

## First run

- A new account sees one compact form (name, role). Appearance, computer and applications sit
  behind one disclosure. Creating a Companion lands directly in a direct conversation with it,
  offered starter prompts and the composer.

## Validation

- Rendered against real Chrome at 1440×900, 1100×900, 768×900, 390×844 and 320×844, plus a
  reduced-motion pass. Checks cover the rail, row menu, composer growth, workspace tabs, details,
  focus and overflow.
- `DISCUSSION_SCREENSHOTS=<dir>` retains captures; preview fixtures stay in ignored artifacts.
- Theme parity is checked by rendering the built stylesheet with `data-theme="dark"`; both themes
  must keep text legible and borders visible.
- No Box or live model is required for this visual work.
