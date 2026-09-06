#!/bin/sh
set -eu
# Runs only inside the owned Linux proof container, in a fresh private mount/PID/network namespace.
mount --make-rprivate /
mount --bind / /
mount -o remount,bind,ro /
mount -t tmpfs tmpfs /tmp
mount -t tmpfs tmpfs /home
mount -t tmpfs tmpfs /run
mkdir -p /run/companions-desktop
mount --bind /broker /run/companions-desktop
mount -t tmpfs tmpfs /broker
mount -t tmpfs tmpfs /admin
mount -t tmpfs tmpfs /sys
mount -t tmpfs tmpfs /dev
mknod -m 666 /dev/null c 1 3
mknod -m 666 /dev/zero c 1 5
mknod -m 666 /dev/random c 1 8
mknod -m 666 /dev/urandom c 1 9
mount --bind /state /state
mount -o remount,bind,rw /state
exec setpriv --reuid=1100 --regid=1100 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs python3 /proof/worker.py
