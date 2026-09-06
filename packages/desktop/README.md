# Desktop broker

This package is the only agent-facing path to a Companion's graphical desktop. The broker runs as
the desktop user and exposes two Unix sockets:

- `DESKTOP_AGENT_SOCKET` (default `/run/companions-desktop/agent.sock`) accepts typed screenshot,
  click, type, key, and scroll actions.
- `DESKTOP_ADMIN_SOCKET` (default `/run/companions-desktop-admin/control.sock`) accepts only durable
  takeover state from the trusted runtime bridge. The headless agent UID must not see this socket.

The SQLite journal lives under `DESKTOP_STATE_DIR` (default `/var/lib/companions-desktop`). Every
boot is fail-closed until the admin reconciles the stored generation and desired state. A newer
generation interrupts and quiesces work from the preceding epoch before admission can reopen.
Actions use stable UUIDs: an identical completed retry returns its stored result, changed input is
rejected, and an action found `started` after restart is `interrupted` and never replayed.

The fresh journal starts with durable generation `0` and desired `taken=false`, while effective
state remains `taken=true, confirmed=false`. This lets the runtime reconcile its matching initial
PostgreSQL state without inventing a transition.

`CommandDesktopDriver` executes fixed argv through `/usr/bin/xdotool`; it never invokes a shell or
launches an application. Capture uses `/usr/local/bin/companions-desktop-capture`, which must emit
one bounded PNG on stdout. The Box image supplies Xvfb, xdotool, X11/XTest libraries, ffmpeg, and
that fixed capture helper. Long text is sent in chunks so takeover can interrupt it, then the driver
releases common modifiers and mouse buttons and completes an X11 round trip before confirmation.

Build `run.ts` as the separate desktop-UID executable. Agent code should use
`desktopTools({socketPath, runId})`; it speaks only to the agent socket and returns
`{"error":"desktop_paused"}` promptly while human takeover is active.
