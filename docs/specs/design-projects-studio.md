# Design projects and the operational studio

This slice builds on the typed workbench foundation (PR #35). It makes a web design deliverable
real: project brief → native Pi file work → durable publication → sandboxed preview → revision.
OpenDesign remains a reference, not a dependency or a claim of complete feature parity.

## A conversation is not a project

A Design Companion owns many persistent projects. A project owns a name, a versioned brief and
many independently versioned design artifacts. One continuous conversation can discuss ten or
more designs across these projects without creating more Companions or new Pi histories.
There is no ten-project or ten-design product limit. Project lists and revision history paginate.

The project picker is view state stored per Companion in the browser session. It never rewrites
messages, changes an in-flight task or moves artifacts. The composer shows the destination of the
next message. General conversation remains available without a project. Project creation works
from the UI or the agent's typed project controls; select the project to begin its design work.

Message admission persists the explicit project ID and a frozen snapshot of its name, brief
revision and skill identity. A repeated client message ID cannot change that project. Changing
the brief affects later requests. A message for another project or brief revision waits for the
active response to settle; matching snapshots retain native Pi steering. Background histories,
compaction, main transcript continuation, cancellation and request IDs retain their existing owners.

Projects can be renamed, edited, archived and restored with optimistic revision checks. Archiving
preserves files, briefs, history and previews; it blocks new project messages and publication.
Already accepted work retains its original context and can finish its local work. A stale brief
edit keeps the user's draft instead of silently overwriting a newer revision.

## Profile and pack versions

The released `design-v1` foundation keeps its exact `design-foundation@1.0.0` identity and staged
capabilities. It remains readable and retryable, but is no longer offered for fresh creation.
`design-v2` is the selectable operational Design profile, with
`first-party/design-studio@1.0.0`. Existing Companions are never silently retyped.

The studio's SKILL.md and craft/critique references are pinned by SHA-256 and embedded into the
agent binary during the existing distribution build. Before a project run starts, the runtime
verifies the embedded digests and stages an immutable copy under
`workspace/.design/runs/<runId>/skill/`, alongside `context.json`. No downloads or dependency
installation occur on wake. User brief data remains distinct from skill instructions. The skill
guides references, DESIGN.md, typography, responsive implementation, iteration and honest critique.

Editable project work lives under `workspace/projects/<projectId>/`. Files attached through chat
arrive through the existing inbox; the agent can deliberately copy relevant assets into the project.
The Assets surface shows that project's attachments from the currently loaded conversation, not
a complete filesystem browser. Design-system material is a real project file such as DESIGN.md;
there is no simulated visual system editor.

## Native publication and provenance

`publish_design` is a native runtime tool bound to the accepted project's context. It takes a
source path, title, stable publication ID, artifact ID and expected previous revision ID. The model
does not supply owner, Companion, run, skill, project revision, timestamps or a free-form manifest.
The generic companion_control tool does not expose the internal `design_publish` transport operation.

The runtime journals the publication intent before reading and snapshotting output. It opens a
bounded UTF-8 file inside the exact project directory, checks the opened Linux file descriptor,
rejects escapes/symlinks outside that directory and writes a separate, fsynced snapshot at:

`artifacts/projects/<projectId>/<artifactId>/<publicationId>.html`

The existing durable control outbox carries its bounded bytes and digest. The server checks current
run authority, ownership, frozen project context, exact source path/digest and predecessor before
atomically publishing an append-only schema-v2 revision and typed event. This is an authenticated
Companion runtime boundary; it is not an upload endpoint accepting arbitrary browser manifests.
The server derives authoritative provenance and revision numbering. An artifact cannot move projects.
PostgreSQL keeps the immutable preview available while the Companion's machine sleeps.

Completed local publication IDs return their original result. A conflicting reuse is rejected.
Interrupted or uncertain effects are never automatically replayed; inspect `design_history` for
the publication/revision ID before deciding on a new operation. Local journal records and snapshots
remain after failure. Predecessor conflicts and failed publication retain the last valid preview.
Schema-v1 records and their provenance remain intact and readable without backfill.

## Preview and critique

The host renders only the existing sanitized, sandboxed static document. Scripts, SVG, external
network assets, embedded frames, navigation and forms are removed or blocked. Fit-width/mobile
preview controls and HTML download operate on this inert document. A download is a preview export,
not an executable application or a complete source-workspace archive.

The skill asks the agent to inspect actual desktop/mobile screenshots when a headless browser is
available in its prepared Linux environment. This slice does not install a browser on wake or
pretend all Box images already contain one. Without one, the real published preview supports human
visual feedback; the agent must disclose that source checks are not rendered critique. Automated
cross-image browser preparation and a quality benchmark for real-model design output remain follow-ups.

## Delivery and boundaries

Apply the additive project migration, build and deploy the API/web and updated agent distribution.
Design-context requests require a daemon advertising `designStudioVersion: 1`; incompatible runtimes
fail before dispatch with an upgrade message. Use the existing runtime-update workflow to replace
old runtime binaries, preserving disk and journals. Rollback retains tables, snapshots, profile IDs
and admitted requests. Never drop history, retype existing Companions or replay unknown runs.

This is a project-based static web studio. Full OpenDesign parity—live executable artifacts,
slides/video/image generation, a rich canvas, a design-system editor, complete asset management,
collaboration and advanced exports—is outside this stacked PR. It preserves a seam for those
capabilities rather than presenting cosmetic controls for unavailable workflows.

## Reference lessons

- [OpenDesign studio overview](https://github.com/nexu-io/open-design): a project groups conversation,
  generated files and preview, with a brief-to-critique loop. Here a Companion conversation can span
  multiple projects, so the admitted project context must be explicit and immutable.
- [Skills protocol](https://github.com/nexu-io/open-design/blob/main/docs/skills-protocol.md): packaged
  skill material, design-system context and per-run staging remain separate from host UI composition.
- [Artifact contracts](https://github.com/nexu-io/open-design/blob/main/packages/contracts/src/api/artifacts.ts):
  stable artifact identity and project/run/skill provenance inform the versioned ledger.
