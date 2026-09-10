# Connected App execution deadlines

Every `plugin_tools` discovery and `plugin_call` owns its MCP connection. The agent applies a
90-second wall-clock budget covering credential refresh, connection, discovery and execution.
Connection is additionally limited to 15 seconds, discovery to 30 seconds and the remote call to
60 seconds, always capped by the remaining budget. Progress notifications do not reset deadlines.
Transport cleanup has a separate maximum of five seconds. Discovery remains lazy; no model call
or connection warm-up is added.

HTTP requests and SSE streams receive operation and transport abort signals. Automatic SSE
reconnection is disabled. Stdio servers run in an owned Linux process group; cleanup sends TERM,
then KILL to that group. A promise that ignores cancellation cannot keep its caller waiting.
Closing the local transport is **not** proof that the remote operation stopped or had no effect.

Only Conductor `get_workspace`, `get_workspace_status`, `get_session`, `get_session_status` and
`list_messages` can retry automatically, once, with a minimum 250 ms backoff. The discovered tool
must declare read-only behavior without a destructive annotation. Only transient failures qualify;
authentication failures, 404 and cancellation do not. `Retry-After` must fit the remaining budget.
Mutations, unannotated tools and tools outside that allowlist never retry automatically.

Status and message polling for one session/workspace is limited to three provider reads (including retries) and 90 seconds
within a response root. Task/session identifiers are passed through only when observed in a
provider response, including structured results. The Companion reports the last observed state
and can use existing background-task mechanisms when continued work is explicitly requested.
A timeout never manufactures a task ID or a successful result.

## Durable uncertainty and recovery

`plugin-calls.sqlite` lives beside the agent's run journal. It records request and Pi tool-call IDs,
root run ID, connection/tool identity, attempt, phase, timing, status and result certainty. It does
not store arguments, credentials or provider response bodies. Intention is committed before
external dispatch and result metadata before the tool result is delivered to Pi. The native Pi
transcript retains the conversational result.

An attempted dispatch is conservatively recorded as `unknown` until a response is observed.
A restart marks pending records interrupted without sending them again. Reusing a tool-call ID
returns a reference to the existing record, never a second external effect. After an uncertain
failure, new mutations in the same root are blocked even if the model invents another tool-call
ID; read-only inspection remains possible. A subsequent user turn is a new run and must still
respect the persisted uncertainty and the user's authority.

The model receives a safe structured error containing a code, request ID, phase, certainty and
retry policy. It has 30 seconds to produce a final explanation after the failed tool returns.
Without a final response, the runtime ends the run with a durable plugin error. Cancellation,
cleanup failures and late callbacks cannot retain the main lane or overwrite settled state.
PostgreSQL projects versioned metadata for the chat and activity, independently of whether the
model successfully explains the error. Unknown external outcomes remain visible after that reply.

## Verification boundaries

Deterministic fixtures cover HTTP/SSE and Docker Linux stdio failures, cancellation, retries,
uncertain mutations, journal restart and late results. Pi tests use a scripted provider and local
MCP fixtures; no hidden model request or production access is needed. Run the agent, server and
web checks through `./dev check`; `./dev check full` includes the Linux plugin fixtures.

These tests establish the corrected local behavior. They do not establish the historical cause
of the reported Grill Me incident: no production transcript or provider trace was inspected.
Deploying this change later requires the rebuilt agent distribution; existing agent binaries do
not gain these protections merely from a server change. The PostgreSQL additions are additive.
