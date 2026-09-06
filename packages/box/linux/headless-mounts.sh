#!/bin/sh
set -eu
# All mounts are private to the root-created process namespace. Never run directly on a host.
mount --make-rprivate /
mount --bind / /
mount -o remount,bind,ro /
mount -t tmpfs tmpfs /tmp
mkdir -p /tmp/agent-state /tmp/desktop-agent
mount --bind "$AGENT_STATE_DIR" /tmp/agent-state
mount --bind /run/companions-desktop /tmp/desktop-agent
cp /run/companions-headless-resolv.conf /tmp/resolv.conf
RESOLV_TARGET="$(readlink -f /etc/resolv.conf)"
mount -t tmpfs tmpfs /home
mkdir -p "$AGENT_STATE_DIR"
mount --bind /tmp/agent-state "$AGENT_STATE_DIR"
mount -o remount,bind,rw "$AGENT_STATE_DIR"
mount -t tmpfs tmpfs /run
mkdir -p /run/companions-desktop
mount --bind /tmp/desktop-agent /run/companions-desktop
case "$RESOLV_TARGET" in /run/*) mkdir -p "$(dirname "$RESOLV_TARGET")"; touch "$RESOLV_TARGET";; esac
mount --bind /tmp/resolv.conf "$RESOLV_TARGET"
mount -t tmpfs tmpfs /var
mount -t tmpfs tmpfs /sys
mount -t tmpfs tmpfs /dev
mknod -m 666 /dev/null c 1 3
mknod -m 666 /dev/zero c 1 5
mknod -m 666 /dev/random c 1 8
mknod -m 666 /dev/urandom c 1 9
exec setpriv --reuid=companions-agent --regid=companions-agent --init-groups \
  --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs \
  /opt/companions/companion-agent
