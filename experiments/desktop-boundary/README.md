# Desktop interaction boundary proof

This optional local Linux experiment makes no Box or model calls. It creates only its named Docker
container; the elevated capabilities apply inside that container, with no developer-host mounts.

```sh
docker build --platform linux/amd64 -t companions-desktop-boundary:proof experiments/desktop-boundary
docker run --rm --platform linux/amd64 --name companions-desktop-boundary-proof \
  --sysctl net.ipv4.ip_forward=1 --cap-add SYS_ADMIN --cap-add NET_ADMIN \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  companions-desktop-boundary:proof
```

The proof observes real X11 key events in a mapped Xvfb window. A headless UID in private mount,
PID and network namespaces uses a broker Unix socket. During takeover, agent events stop while
human events and headless file writes continue. Release resumes agent events. The headless
process also reaches an independent network service, while direct X11 pathname/abstract sockets,
host/loopback browser-control ports, desktop files, admin socket, process-root escape, input
devices and root escalation are unavailable.

This is a primitive-boundary proof, not the product acceptance: the fixture broker is in-memory,
uses one atomic key operation and does not exercise Pi, persistent generations or crash recovery.
Those must be tested against the integrated production broker and runtime separately.

The production acceptance runs the compiled Pi daemon (deterministic provider, real Pi sessions
and tools), production broker and production headless launcher. It interrupts real typing, then
verifies a new chat writes/reads a file, background HTTP requests advance, and human keys continue
on the same X server. Release is followed by a fresh PNG capture and a new GUI action.

```sh
python3 scripts/bun.py scripts/build-agent.ts
docker build --platform linux/amd64 -f experiments/desktop-boundary/Production.Dockerfile \
  -t companions-desktop-boundary:production experiments/desktop-boundary
docker run --rm --platform linux/amd64 --name companions-desktop-production-proof \
  --sysctl net.ipv4.ip_forward=1 --cap-add SYS_ADMIN --cap-add NET_ADMIN \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  --mount type=bind,src="$PWD/dist/agent",dst=/opt/companions,readonly \
  companions-desktop-boundary:production
```

Production acceptance additionally recovers an empty, partially configured network namespace and
rejects a duplicate launcher while the first daemon remains usable. The systemd broker keeps its
runtime directory across restarts so the headless bind mount continues to reach the replacement
socket. Broker journal tests cover closed admission after restart and durable generation recovery.

The independent build-distribution replacement proof uses the same local image:
`python3 scripts/bun.py scripts/test-template-install.ts`. It executes the generated installation
command with fixture systemd responses and a real process mapping the old executable. It verifies
active-unit refusal, atomic replacement, failed-install retry and removal of only obsolete
product distribution copies; it makes no Box calls and does not run host systemd.

The namespace restart regression exercises 100 real launcher network setups (only the final daemon
exec is replaced) and also injects a deletion failure that leaves an interface present:

```sh
docker run --rm --platform linux/amd64 --sysctl net.ipv4.ip_forward=1 \
  --cap-add SYS_ADMIN --cap-add NET_ADMIN --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  --mount type=bind,src="$PWD/packages/box/linux",dst=/opt/companions,readonly \
  --mount type=bind,src="$PWD/experiments/desktop-boundary/network-restart.py",dst=/test.py,readonly \
  companions-desktop-boundary:production python3 /test.py
```

The mount acceptance also checks relative paths (`/etc/../home`, `/etc/../tmp`) and
`/proc/self/root`, plus the resolver seen by the real Pi shell. The headless root is
a distinct bind mount entered with chroot before private masks are installed. Binding
over `/` alone leaves relative symlinks able to traverse the covered root. The test
uses the production desktop-state bridge for both GET and PUT reconciliation.
Legacy retirement and physical state migration have independent optional Linux proofs:

```sh
docker run --rm --platform linux/amd64 \
  --mount type=bind,src="$PWD/packages/box/linux",dst=/opt/companions,readonly \
  --mount type=bind,src="$PWD/experiments/desktop-boundary/legacy-retirement.py",dst=/test.py,readonly \
  companions-desktop-boundary:production python3 /test.py
```

It uses real users, sockets and files, with fixture systemd responses. It checks refusal while
an old service is active, durable offline masking, reintroduced-unit retirement, and untouched
legacy history bytes. Actual user-manager stop still requires the fresh-Box canary.

For migration, use the same Docker command with `state-migration.py` instead of
`legacy-retirement.py`. It verifies history/SQLite/symlink bytes, crashes immediately before and
after directory activation, fresh-child isolation, no full history scan on ordinary wake, and
real UID file/SQLite WAL preflight. Production acceptance independently reads the physical output
and verifies the new file belongs to the headless UID.

Physical state lives at `/var/lib/companions-agent/<configured UUID>`. This change follows a live
Box observation: new files created by the headless UID under `/home/user` were owned by the desktop
UID, while creation and rewriting under `/var/lib` preserved the headless UID. We do not infer a
filesystem implementation from this observation. The namespace binds physical state to the original
`AGENT_STATE_DIR`, retaining Pi's absolute workspace/session identity. The original home directory
remains a backup and is never copied over an activated physical directory. A new child with no
legacy subtree starts empty; other physical identities are hidden by the private `/var` mask.

Migration retires the old service first, copies and verifies all regular-file bytes and symlink
entries, synchronizes the copy, and activates it with an atomic rename and root-owned checkpoint.
Special filesystem entries fail explicitly. Before the daemon starts, the actual unprivileged
process creates, rewrites and renames a file and commits twice to SQLite WAL through the logical
bind. A failed preflight prevents a misleading healthy endpoint. Migration is once per identity;
ordinary wakes only perform the small storage preflight. A failed/ambiguous chat is never replayed
by migration. The optional live canaries verify physical paths via authorized provider commands;
the host's old home path intentionally continues to show the retained backup.
