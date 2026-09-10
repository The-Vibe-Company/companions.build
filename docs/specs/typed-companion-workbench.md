# Typed Companions and the first Design workbench

Status: foundation implemented; Design artifact publication and runtime skill activation are staged.

A specialized Companion is still a Companion. Its immutable `profileId` selects a first-party,
versioned workbench descriptor. Names, instructions and Specialist templates do not select a type.

## Existing architecture and seam

- `apps/server/src/store.ts` owns Companion creation, durable creation fingerprints and projections.
  `api.ts` validates creation; `control.ts` handles ordinary identity edits. PostgreSQL remains the
  web source of truth. An additive `workbench.sql` migration extends this model.
- `apps/web/src/App.tsx` keeps the Companion header, global sections (Team, Automations, Activity,
  Settings, Computer, Applications), history navigation and settings exit guard. Its existing
  `CompanionView` chat slot now delegates to `CompanionWorkbench`. Default chat is returned directly.
  New task modules are composed in that wrapper, without a profile switch in App.
- Specialist library/templates, draft configuration chats, published images and delegated missions
  already have their own lifecycle. They remain inputs to creation and delegation, independent of
  a Companion's workbench identity. The `?specialist=` draft route retains its current behavior.
- The executor still exclusively dispatches persisted requests. Pi native sessions, transcripts,
  branches, compaction, memory and local execution journals are unchanged. Workbench events do not
  become messages or participate in Pi history. No run instructions or request fingerprints change.
- This checkout has `AGENTS.md`, `docs/dev-workflow.md` and bundled `.agents/skills/`; it has no
  `docs/agents/` or discoverable Matt setup/convention entrypoint. Setup uses `./dev setup` and the
  existing development workflow. No alternate convention set was invented.

## Profiles and modules

`packages/workbench/profiles.ts` defines `default-v1` and `design-v1`. Descriptors declare module IDs,
packaged skill versions, capabilities, artifact kinds and runtime requirements. Display names are
editable product copy, not routing identifiers. Future incompatible profile changes get a new ID.

`companions.profile_id` is nullable with no backfill. Missing/null resolves to `default-v1` only at
read time; existing rows are never silently retyped. Unknown read-time IDs conservatively show the
default workbench; creation rejects unknown IDs. The creation form explicitly selects a profile and
freezes it in the existing retry intent. Old saved intents that omit it retain their original hash.
A retry with a different explicit profile conflicts. PATCH rejects `profileId`; a database trigger
also rejects direct profile updates, including null-to-design changes.

The first-party module registry supplies chat, artifact preview, artifact history, assets and design
brief. The React component registry is host-owned. Adding a module means adding its typed descriptor
and host component and composing it in a profile. Neither Markdown, remote JavaScript nor generated
React installs a component. The first layout offers one side module at a time, a hide/open control,
and a stacked narrow-screen layout. Pinning, reordering and persisted layout preferences are follow-ups.

The initial brief reads the Companion's saved instructions and points to Settings for editing.
Assets lists actual attachments in the loaded chat page; it is not a complete workspace filesystem
or asset library. Preview/history read a dedicated persisted projection, not Markdown or chat text.

## Static artifact ledger and provenance

`packages/workbench/artifacts.ts` owns the bounded version-1 schemas. Each immutable revision has:

- a Companion-scoped artifact ID, globally unique revision ID, increasing revision number and
  previous revision ID (null only for revision 1);
- explicit manifest schema version, kind (`static-html`), renderer (`sandboxed-html-v1`), title,
  ready/failed status, safe failure code and timestamp;
- Companion ID, run ID, conversation identity, profile ID and exact skill ID/version;
- a relative path under the Companion workspace's `artifacts/` namespace and SHA-256 source digest.

Main conversation identity is `{kind: main, id: companionId}`. Background identity is
`{kind: background, id: responseRootRunId ?? runId}`. These are web provenance keys, not Pi session
IDs; the publisher verifies them against the persisted run. A future Pi-session reference can be
added in a new schema without changing native session ownership.

`publishArtifactRevision` is a trusted internal persistence seam, **not an exposed HTTP/agent tool**.
It validates ownership, profile/skill, run/conversation, source digest for ready HTML, sequence and
idempotency; locks the Companion and atomically inserts the revision plus an `artifact.revision`
event. An exact retry returns the original record; collisions and missing predecessors fail.
The ledger is append-only. Failed attempts have no HTML and cannot replace earlier ready snapshots.
Only safe failure codes are stored, not provider errors or credentials.

The source file belongs to the Companion's persistent Linux workspace. PostgreSQL stores the
manifest and immutable preview snapshot so preview history is available without waking that machine.
This slice does not write or read source files on agents: the future trusted publisher must resolve
real paths inside the owning workspace (rejecting traversal/symlinks), write a distinct immutable
revision file, verify its bytes and persist through the seam. The path is currently a validated
provenance claim from trusted internal callers, not proof of a remote file read. Never expose the
seam to agent-provided manifests until that verification and durable publication journal are built.

The owner-authenticated workbench GET returns the newest 100 revision manifests plus up to 100 typed
events, with a truncation indicator for history. Preview GET returns only HTML and its revision ID.
An optional `revisionId` selects the last ready snapshot at or before that historical revision.
Retirement retains owner-readable history and previews while preventing new publication.

Database notifications remain identifier-only invalidations; the UI re-reads persisted state.
`workbench.open` is a validated contract for requesting an existing module, with the same provenance.
The UI ignores old focus requests on initial load and rejects wrong-Companion/unregistered events.
No agent endpoint or event persistence operation for `workbench.open` is enabled yet. Opening a module
does not install it or save a layout preference.

## Preview boundary and failure behavior

HTML is bounded before parsing into an inert template. The client serializes only allowlisted HTML
elements and attributes; scripts, handlers, embedded documents, navigation, remote media, SVG and
forms are removed. Styling is retained; inline raster data images are allowed. The result is loaded
only through an iframe with an empty `sandbox`, an opaque origin, no referrer and restrictive CSP:
no scripts, network connections, external fonts, frames, objects, form actions or base URLs.
It never enters the host React DOM as generated UI. Remote fonts/assets and interactivity are not
supported in this static renderer.

A replacement is staged in a hidden iframe and promoted after load. Validation/fetch/render failures
or a render timeout leave the previous loaded frame intact. Failed generations read the last ready
persisted snapshot, including after reload. Browser coverage verifies host isolation, opaque origin,
blocked external requests and responsive module interaction; UI coverage exercises replacement failures.

## Versioned Design skill pack

`packages/workbench/skills/design-foundation/1.0.0/` contains an owned SKILL.md, a visual critique
reference and a manifest with pinned file digests. Its status is explicitly `staged`. Editing pack
content requires a new version and deliberate profile version selection; never mutate a released pack.
It teaches brief/reference-driven composition, high-fidelity implementation, rendered critique and
honest validation. It is a bounded foundation, not a validated end-to-end design product.

`composeDesignContext` defines a deterministic per-run plan: saved brief, optional versioned design
system, reference descriptors, asset descriptors, then the exact skill pack. User material remains
separate from skill instructions; UI components are not context payloads. File descriptors carry
paths and hashes. No dependency installation, global skill mutation or Pi context rewrite is added.

The next runtime slice must build the pack into the agent distribution before deployment, verify
hashes and stage a real run-scoped copy with its references/assets, persist the selected composition
before dispatch, preserve durable request IDs, and never replay ambiguous publication or execution.
It must validate actual design output and browser critique before claiming high-fidelity capability.

## Specialist migration and live artifacts

Existing Specialists continue as reusable configuration/image/template inputs. Creating a Design
Companion from a template explicitly selects `design-v1`; the template does not override that choice.
Existing template-based Companions remain null/default. A future template export may *suggest* a
profile for a new Companion, but cannot retype one or derive a profile from its name. Any migration
of the Specialist library terminology and UI should be reviewed separately from profile persistence.

Live/refreshable artifacts need a separate model and API: source/connector permissions, refresh IDs,
locks, pending/running/failed/stale states, cancellation and independently retained last-good output.
Do not add a live URL or executable React variant to this static contract. Refresh state must not
change an immutable source revision; UI events must follow committed refresh state. Rich canvas,
full design-system editing, handoff and live rendering are explicitly outside this slice.

## Migration and rollback

Build and verify the release, apply the additive migration before starting the updated API. Existing
Pi runtimes require no update for this foundation. Null profiles are not rewritten and no transcripts,
runs, machine resources or template revisions are migrated. Old binaries can continue reading their
existing columns, but would render Design Companions with the default UI; keep creation on the updated
API/UI to avoid that downgrade in behavior. Rollback retains all added columns/tables and the immutable
profile trigger. Do not drop artifact history, retype rows or replay runs to roll back this feature.

## Reference lessons

OpenDesign is a reference only; no code or dependency was imported.

- [Skills protocol](https://github.com/nexu-io/open-design/blob/main/docs/skills-protocol.md): portable
  SKILL.md bundles, declarative metadata and run-scoped staging informed the pack/context boundary.
- [Artifact contracts](https://github.com/nexu-io/open-design/blob/main/packages/contracts/src/api/artifacts.ts):
  explicit kinds/renderers and provenance informed the stricter immutable revision contract here.
- [Live artifacts spec](https://github.com/nexu-io/open-design/blob/main/specs/2026-04-29-live-artifacts/spec.md):
  independent refresh lifecycle and retained previews informed the static/live split.
- [Live schemas](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/live-artifacts/schema.ts) and
  [renderer](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/live-artifacts/render.ts): bounded
  inputs and inert rendering informed validation; the browser parser, allowlist and sandbox remain ours.
