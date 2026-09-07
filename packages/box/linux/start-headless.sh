#!/bin/sh
set -eu
# Runs after namespace masks, logical bind and privilege drop; a reachable health
# endpoint must never precede usable SQLite/file storage on the actual mount.
python3 /opt/companions/state-preflight.py "$AGENT_STATE_DIR"
exec /opt/companions/companion-agent
