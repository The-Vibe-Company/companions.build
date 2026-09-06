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
web behavior tests and the production web build. Cleanup selects only the current verification
label. A passing run prints its evidence path under `.artifacts/verification/<run-id>`.

This command proves the integrated controlled path with a real PostgreSQL database, private object
storage, the compiled Pi/Bun program in Linux, the deterministic model, MCP fixtures, API, worker,
executor, and web build. It does not contact Box, Stripe, email delivery services, OAuth providers,
or paid models.

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
```

The model canary proves one configured provider/model can answer through the packaged runtime. The
Box canary proves prepared snapshot lookup, creation, real tool execution, archive, and resume of
the same disk; `--wake-only` intentionally reuses its retained Box. The desktop canary verifies a
runtime-confirmed freeze and release against a real subprocess on Box. Record provider, artifact
revision, timestamps, raw phase measurements, and limitations in `docs/measurements/` without
recording credentials or signed URLs.

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
  cross-owner bundle access; client activation waits for a ready immutable bundle.

Never weaken an assertion because a simulator cannot prove it. Add a test at the lowest boundary
that can prove the promise, and describe any remaining live-provider evidence separately.
