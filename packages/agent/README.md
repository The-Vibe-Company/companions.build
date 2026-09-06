# Companion agent daemon

The daemon binds `0.0.0.0:${PORT:-8787}` and stores its SQLite request journal, Pi sessions, and
isolated workspace below `${AGENT_STATE_DIR:-/home/user/.companions}`. `AGENT_TOKEN` is required;
every request uses `Authorization: Bearer <token>`. Production also requires `MODEL_PROVIDER` and
`MODEL_ID`. Provider credentials use Pi's standard environment variables, such as
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`.

Protocol:

- `GET /health` returns `{ready, version, activeRunId}`.
- `PUT /runs/:uuid` with `{content, instructions}` durably accepts one active run and returns `202`.
  Repeating the UUID and exact body returns its existing state. A changed body returns
  `409 IDEMPOTENCY_CONFLICT`.
- The daemon does not own a second scheduler. While one run is active, a different UUID returns
  `409 BUSY` and is not persisted; the controller retries after the active run settles.
- `GET /runs/:uuid` returns the durable status and final text or stable error code.
- `POST /runs/:uuid/cancel` aborts active Pi work and durably returns `cancelled`; terminal calls are
  idempotent.

At startup every journal row left `running` is changed to `interrupted` with
`DAEMON_RESTARTED`. The daemon never dispatches those rows again, including when the original PUT
is retried after a crash.

`AGENT_TEST_MODE=1` enables the compiled deterministic model used only by Linux acceptance tests.
Production never selects it implicitly.
