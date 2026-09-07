# Visual direction research — 7 September 2026

Status: proposal awaiting the owner’s visual choice. No frontend redesign applied.

The owner requests a restrained, distinctive, highly polished interface with personality carried
by colorful geometric Companions and faces. Preserve shadcn and AI Elements. Keep navigation and
settings concise. Three GPT Image concept previews were generated: Atelier, Papier, Studio nuit.
They are visual explorations, not functional screenshots or accepted specifications.

## Primary references and interpretation

- [Linear, March 2026 refresh](https://linear.app/now/behind-the-latest-design-refresh):
  navigation recedes, unnecessary icon treatments and borders are reduced, defaults move toward
  warmer neutral grays. Apply hierarchy and consistent action placement, not its issue-management density.
- [Linear settings](https://linear.app/changelog/2024-12-18-personalized-sidebar):
  separate settings by ownership/scope and expose summaries before full configuration.
- [Things](https://culturedcode.com/things/): reference for a personal tool with approachable task
  organization and restrained UI. Interpretation: preserve breathing room and progressive controls.
- [Notion Faces](https://www.notion.com/help/notion-faces): customizable character identity.
  Interpretation: recognizable expressive Companions can carry branding without decorating every surface.
- [Radix Colors](https://www.radix-ui.com/colors): semantic steps for surfaces, interactions,
  borders and text, including warm Sand neutrals. Palette choices still require contrast checks.
- [shadcn theming](https://ui.shadcn.com/docs/theming): semantic CSS variables support an authored
  visual identity and consistent light/dark variants without replacing components.
- [Inter](https://rsms.me/inter/): candidate readable UI typeface; use one family for product labels.

## Recommended direction, not yet approved

Refine Atelier toward a nearly white warm neutral canvas, charcoal text and compact restrained
controls. Keep character silhouettes/colors distinctive. Avoid beige wash, large character portraits
in settings, boxed chat paragraphs, and repeated cards. Studio nuit should be the dark appearance of
the same layout rather than a different navigation system. Papier is a viable crisper alternative.

Sidebar: Companions, new Companion, Connections, Account. Selected Companion: Chat and Activity;
a separate settings action opens contextual Profile, Tools, Automations and Team/Delivery settings.
Global billing and appearance belong to Account, not per-Companion settings. Do not display the
settings inspector permanently. Mobile uses the same grouping in a full-screen settings view.

Proposed visual parameters: 14–15px body, 20–24px section headings, 32–40px navigation avatars,
8–12px control radii, restrained hover transitions and reduced-motion support. Use vivid companion
colors primarily for identity; status colors retain their own semantic meaning. These are authored
recommendations, not findings measured from the reference products.
