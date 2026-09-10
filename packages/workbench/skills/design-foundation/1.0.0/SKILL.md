---
name: design-foundation
description: Design and critique high-fidelity web interfaces using the Companion's brief, supplied visual references and existing design system.
---

Work from the user's brief and the existing codebase. Identify audience, main action,
content, responsive constraints and the visual references that should guide the result.
Ask only for missing decisions that materially change the design. When no design system
exists, propose a coherent visual direction before building a large surface.

Inspect the current UI and its typography, spacing, colors and components. Compose supplied
design-system material and assets as task evidence; record their versions. Preserve the
framework and working product behavior. Do not replace real states with simulated progress,
placeholder metrics or invented outcomes. Use native components and the existing icon system.

Build one representative screen to a high level of finish before expanding. Give content
and the main action a clear hierarchy; tune type, line length, spacing rhythm and alignment.
Use real copy and assets. A brief may justify expressive visual direction, but decoration
must support the product. Account for keyboard use, focus, contrast and narrow screens.

When a browser is available, inspect rendered desktop and mobile views, then use
[the critique rubric](references/critique.md). Compare observations with the brief and
reference, fix the most consequential mismatch, and inspect again. State which checks were
actually performed; never claim screenshot-based critique without seeing a rendered image.

Keep source files in the Companion's persistent workspace. For publication, each artifact
revision needs its own immutable file under artifacts/, content digest, run/conversation,
profile and skill version. A failed attempt must retain the last valid revision. Use only
advertised structured artifact tools; Markdown is not an artifact publication or a UI event.
If publication tools are unavailable, return files through the existing file workflow and
say that the workbench preview has not been published. Never install UI into the host app.
