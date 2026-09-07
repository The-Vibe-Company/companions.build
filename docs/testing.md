# Testing and evidence

The test strategy separates deterministic product behavior from credentialed provider evidence.
A passing local suite is required, but it is not a claim about model quality, live providers,
hosted performance, or production operations.

## Standard verification

Run from the repository root:

```sh
python3 scripts/verify.py
```

The verifier creates a unique artifact directory and uniquely labeled PostgreSQL and MinIO
containers. It installs both lockfiles with frozen versions, typechecks, runs agent unit tests,
builds the Linux agent, exercises the server through `scripts/test-server.ts --linux`, then runs
web behavior tests and the production web build. It then creates a real Better Auth session and a
queued turn, takes a PostgreSQL 17 custom-format backup, kills that database container, restores
into a fresh PostgreSQL 17 container, and verifies through the authenticated API that the session,
Companion, message, queued turn, and stable message id all remain valid. Cleanup selects only the
current verification label. A passing run prints its evidence path under
`.artifacts/verification/<run-id>`.

The recovery check retains its synthetic session cookie, database dump, and local auth/encryption
keys only inside the mode-0700 evidence directory. A real restore must recover the matching
application-managed auth and encryption keys from its secret store alongside PostgreSQL; those keys
are intentionally not embedded in the database backup.

Use the explicit PostgreSQL 18 variant to exercise the same populated crash-and-restore path on the
pinned production database major:

```sh
python3 scripts/verify.py --postgres 18
```

The selected major applies to both the source and recovery containers. The default remains
PostgreSQL 17 for the ordinary local loop; neither variant contacts a hosted database.

This command proves the integrated controlled path with a real PostgreSQL database, private object
storage, the compiled Pi/Bun program in Linux, the deterministic model, MCP fixtures, API, worker,
executor, and web build. It does not contact Box, Stripe, email delivery services, OAuth providers,
or paid models.

The dated [validation report](validation-v0.md) records the exact integrated runs and live
observations. Always match an artifact to the commit it tested; focused browser or provider
checks do not replace the standard verifier after a runtime change.

## Focused loops

Use the smallest suite that proves a change, then run the standard verifier before integration.

```sh
# TypeScript across the repository
python3 scripts/bun.py node_modules/typescript/bin/tsc

# Server behavior suites
python3 scripts/bun.py test apps/server/test

# Agent journal, environment, and daemon behavior
python3 scripts/bun.py test packages/agent/test

# Web component/API behavior and production bundle (run from repository root)
python3 scripts/bun.py run --cwd apps/web test
python3 scripts/bun.py run --cwd apps/web typecheck
python3 scripts/bun.py run --cwd apps/web build
```

The root verifier remains authoritative because several server behaviors require its fresh
PostgreSQL and MinIO configuration. Direct file-storage acceptance can be requested with
`RUN_STORAGE_ACCEPTANCE=1`, but the root verifier already enables it against a private bucket.

Chat event tests use real PostgreSQL `LISTEN`/`NOTIFY` across separate connections. Notifications
are bounded invalidation hints rather than a durable event log: the test must also prove that a
reconnected client reloads the durable owner-scoped snapshot and sees changes whose notification
it did not receive.

## Packaging and fault matrix

```sh
python3 experiments/pi-bun/verify.py
python3 experiments/pi-bun/verify.py --scenario 'crash after'
```

The experiment builds the distribution and runs it inside Linux without a preinstalled Node, Bun,
or package manager. It covers Pi tools, file persistence, separate sessions, native steering,
cancellation, restart recovery, skills, MCP HTTP/stdio, and image input. The fault scenario checks
that losing an acknowledgement after a real tool effect does not blindly replay the effect.

This is packaging and protocol evidence. Its timings describe the controlled machine, not Box
creation, wake, network, or model latency.

## Browser validation

For frontend changes, start a dedicated stack with a port unused by other worktrees:

```sh
CONDUCTOR_PORT=5210 BILLING_TEST_MODE=1 python3 scripts/dev.py
```

Use the printed Mailpit inbox to complete the real Better Auth magic-link flow. Validate the
changed paths at desktop and narrow mobile widths with `agent-browser`. Check the accessibility
snapshot, persisted state after reload, network failures, and console errors. Save screenshots
under `.artifacts/`; they are local evidence and must not be committed.

`BILLING_TEST_MODE=1` is development-only. It proves activation behavior without a live charge and
must be labeled as test access in the UI. It does not prove Stripe checkout, subscription changes,
portal behavior, invoices, or meter delivery.

## Credentialed canaries

These checks are optional, may create paid resources, and require explicitly configured secrets:

```sh
AGENT_TEST_MODE=0 python3 scripts/bun.py scripts/live-model-canary.ts
python3 scripts/bun.py scripts/live-box-canary.ts
python3 scripts/bun.py scripts/live-box-canary.ts --wake-only
python3 scripts/bun.py scripts/live-desktop-canary.ts
python3 scripts/bun.py scripts/live-skills-canary.ts
python3 scripts/bun.py scripts/live-skill-install-canary.ts
```

The model canary proves one configured provider/model can answer through the packaged runtime. The
Box canary proves prepared snapshot lookup, creation, real tool execution, archive, and resume of
the same disk; `--wake-only` intentionally reuses its retained Box. Template preparation must also
verify immutable snapshot re-entry by observing the existing snapshot with GET and performing no
reinstall. The desktop canary verifies a runtime-confirmed freeze and release against a real
subprocess on Box. The skills canary verifies hashed export, idempotent import, daemon discovery,
and actual Pi use on a real Box. Record provider, artifact
revision, timestamps, raw phase measurements, and limitations in `docs/measurements/` without
recording credentials or signed URLs.

The chat skill-install canary uploads an actual `SKILL.md` attachment through the authenticated API,
asks Pi to install it with its file/shell tools, verifies exported bytes and resource listing, then
checks a fresh challenge in a second turn against an independently calculated digest and the daemon
journal. It uses an existing, otherwise idle Box Companion: set `SKILL_INSTALL_COMPANION_ID`, or
`BOX_CANARY_STATE_FILE` pointing to a journal with `companionId` or `parentId`. Use the running stack's
environment and authenticated `.local/session-cookie` (`SKILL_INSTALL_SESSION_FILE` overrides it).
`SKILL_INSTALL_CANARY_STATE_FILE` defaults to `.local/live-skill-install-canary.json`; retain it to
resume with the same message/file IDs. Failed or ambiguous runs stop the check without replay.
The uniquely named installed skill remains on that Companion. This checks discovery and subsequent
behavior; it does not inspect Pi's internal resource-selection trace.

There is currently no automated live acceptance for every OAuth provider, managed GitHub/Sentry
registration, Stripe subscriptions/meters, SMTP deliverability, broad desktop application behavior,
or concurrent hosted load. These require separate evidence before launch claims.

## Required behavioral evidence

Tests should assert durable state or independently observed effects rather than trusting an agent's
text response. Important boundaries include:

- two users cannot list, read, mutate, download, delegate, bill, or accept data outside their
  ownership and verified-email rules;
- repeated stable IDs return the same accepted operation, while the same ID with changed content
  conflicts;
- intent is durable before Box, Pi, object storage, provider webhook, or Stripe effects;
- an ambiguous dispatch or snapshot submission is observed or interrupted, never blindly repeated;
- attachment bytes, hashes, count gates, ownership, and output retention survive retries;
- main and background lanes remain independent, FIFO within each lane, and release capacity while
  waiting for a persisted human answer;
- webhook signatures cover raw bounded bytes, redeliveries deduplicate, filters cannot reach the
  network, and rejected events never enqueue model work;
- a temporary child archives only after its result files and selected template capture are durable;
- billing events and usage operation IDs deduplicate, and no unconfigured installation projects a
  paid subscription;
- maintenance access is absent unless requested and explicitly accepted, and revocation is final;
- portable skill manifests reject traversal, links, credential-like files, invalid hashes, and
  cross-owner bundle access; client activation waits for a ready immutable bundle, lifecycle
  preparation stages it once by hash, and specialist revisions retain the selected bundle;
- warm accepted work must progress while an unrelated machine prepares, and every provider effect
  plus its durable checkpoint must fail closed after executor leadership loss. The focused fault
  tests protect both promises and run in the standard verifier.

Never weaken an assertion because a simulator cannot prove it. Add a test at the lowest boundary
that can prove the promise, and describe any remaining live-provider evidence separately.


## Live plugin discovery and consent

```sh
# Public protected-resource/authorization metadata, no account access or provider writes
python3 scripts/bun.py scripts/probe-plugin-oauth.ts

# Start the real application OAuth flow; does not grant consent or call account tools
API_PORT=4411 python3 scripts/bun.py scripts/probe-plugin-oauth.ts --authorize
```

The first command validates the pinned resource and authorization origins and writes a sanitized
report under `.artifacts/plugin-oauth/`. The optional second command uses `.local/session-cookie`,
may register OAuth clients, and stores consent links only in the private
`.local/plugin-oauth-consent.json`. Those links expire and must never be committed. A successful
start is not a successful connection: human consent and an authenticated provider tool call are
separate acceptance steps. GitHub, Slack and Gmail also require deployment OAuth-client settings.
