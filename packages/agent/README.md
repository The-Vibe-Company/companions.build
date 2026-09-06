# Companion agent daemon

The daemon binds `0.0.0.0:${PORT:-8787}` and stores its SQLite request journal, Pi sessions, and
isolated workspace below `${AGENT_STATE_DIR:-/home/user/.companions}`. `AGENT_TOKEN` is required;
every request uses `Authorization: Bearer <token>`. Production also requires `MODEL_PROVIDER` and
`MODEL_ID`. Provider credentials use Pi's standard environment variables, such as
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`.

Protocol:

- `GET /health` returns `{ready, version, activeRunId, activeRuns: {main, background}}`.
- `PUT /runs/:uuid` with `{content, instructions, lane?: "main" | "background"}` durably accepts a run and returns `202`.
  Repeating the UUID and exact body returns its existing state. A changed body returns
  `409 IDEMPOTENCY_CONFLICT`.
- Main sends during work use Pi's native steering. Their journal rows retain distinct IDs and
  share a `responseRootId`; the group settles atomically and only its root contains the response.
  A background run has a separate Pi session and never blocks main admission. A second background
  UUID returns `409 BUSY` without journal acceptance; PostgreSQL owns its FIFO queue.
- `GET /runs/:uuid` returns `{id,status,text,error,lane,responseRootId,publishToChat}`.
- `POST /runs/:uuid/cancel` aborts active Pi work and durably returns `cancelled`; terminal calls are
  idempotent. Cancelling a main steer cancels its shared response, leaving background untouched.

Main history continues across sends. Every background task gets a fresh history under
`sessions/background/<runId>`. Both lanes load the shared `workspace/MEMORY.md` at session start.
Background results stay in task activity unless Pi selects a summary with `publish_to_chat`;
publication occurs only after successful settlement, without a new main-model call.

Integration hooks: `PiExecutor.toolsFactory` creates per-session tools and closes their resources
after completion. `AgentDaemon` accepts an authenticated extra request handler for control/config
routes. These hooks do not replace native Pi steering or execute package installation on wake.

At startup every journal row left `running` is changed to `interrupted` with
`DAEMON_RESTARTED`. The daemon never dispatches those rows again, including when the original PUT
is retried after a crash.

`AGENT_TEST_MODE=1` enables the compiled deterministic model used only by Linux acceptance tests.
Production never selects it implicitly.
