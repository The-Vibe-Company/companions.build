# Flat companion navigation — 7 September 2026

This supersedes the nested settings navigation from the preceding pass.

There is one companion navigation row: Discussion, Automations, Team, Activity,
Computer (Box only), Settings. These render in the workspace and have direct view URLs.
Retired companions expose only read-only Discussion and Activity. The header gear and
redundant Activity button are removed; pending questions retain a direct Needs you action.

Automations presents routines and events together without nested navigation. Settings is
one page: name, purpose, collapsed appearance/model preferences, applications, collapsed
client delivery, and confirmed deletion. Appearance colors wrap instead of being clipped.
Chat and visited Settings stay mounted across primary tabs, preserving unsaved drafts.
Computer controls preserve human ownership when the user leaves; no machine is started
just by opening a tab. Native modal settings remain only as an unused compatibility mode.

Validation:

- 70 frontend tests pass, including computer cleanup, read-only histories, deletion,
  navigation and draft behavior. TypeScript and production build pass.
- Authenticated browser checks at 390 and 1440 pixels: no secondary navigation, no
  settings dialog, no page overflow; draft retained across Discussion/Settings; Activity
  visible on mobile; both automation sections present; all avatar colors fit the page.
- No provider action, save, account change or machine launch was performed during these
  visual checks. The owned browser was closed; the development stack remains on 4410.
- Backend is unchanged by this navigation pass. The prior complete backend verification
  remains bfa6c85a9207, with the authenticated deletion canary recorded separately.
