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
  --mount type=bind,src="$PWD/packages/box/linux/launch-headless.py",dst=/launcher.py,readonly \
  --mount type=bind,src="$PWD/packages/box/linux/retire-legacy.py",dst=/opt/companions/retire-legacy.py,readonly \
  --mount type=bind,src="$PWD/experiments/desktop-boundary/network-restart.py",dst=/test.py,readonly \
  companions-desktop-boundary:production python3 /test.py
```

The mount acceptance also checks relative paths (`/etc/../home`, `/etc/../tmp`) and
`/proc/self/root`, plus the resolver seen by the real Pi shell. The headless root is
a distinct bind mount entered with chroot before private masks are installed. Binding
over `/` alone leaves relative symlinks able to traverse the covered root. The test
uses the production desktop-state bridge for both GET and PUT reconciliation.
Legacy retirement and mixed ownership have their own optional Linux proof:

```sh
docker run --rm --platform linux/amd64 \
  --mount type=bind,src="$PWD/packages/box/linux/retire-legacy.py",dst=/retire-legacy.py,readonly \
  --mount type=bind,src="$PWD/experiments/desktop-boundary/legacy-retirement.py",dst=/test.py,readonly \
  companions-desktop-boundary:production python3 /test.py
```

It uses real users, ownership changes, sockets and files, with fixture systemd responses. It tests
refusal while the old service is active, offline masking, a root-directory-only partial migration,
retained history bytes, no second recursive chown, and explicit failure on changed entry ownership.
Actual user-manager stop and provider preview routing require the fresh-Box live canary.
