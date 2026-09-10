Companion creation preparation — local validation, 2026-09-10

Workspace began clean at `0ef0032394433d47749669feacc46dc88e288f29`, on
`conductor/companionsbuild-fix-fast-start-for-everyone`. No branch rename,
commit, push, Railway change or deployment was performed.

The HTTP creation route already defaults `prepare` to true. Both web creation
forms explicitly sent false, leaving machine startup until the executor observed
a first message. The change requests preparation when the new Companion is
persisted, overlapping machine startup with account grants, specialist permissions
and the user's time composing a message. The API still only persists intent;
the executor retains provider effects, admission limits and recovery authority.

An additional compatibility fix handles pending browser setup saved by an older
version. Its frozen `prepare:false` request must remain unchanged because prepare
is part of the creation fingerprint. After creation acknowledgement, the form
requests preparation through the existing lifecycle endpoint and persists that
acknowledgement across optional-grant retries and remounts. New requests need no
second preparation endpoint call. No model warmup request was added.

| Creation path | Audited behavior |
| --- | --- |
| Individual, first Companion, starting profile | `CreateCompanion.tsx` now sends true; chosen template/revision and creation identity stay frozen. |
| New team coordinator | `CreateTeamWizard.tsx` now sends true; completed grants and coordinator identity survive retries. Review copy describes preparation. |
| Existing team coordinator and selected specialist profiles | Permissions only; there is no new machine to prepare. Selecting profiles does not instantiate specialists. |
| HTTP callers omitting prepare | `apps/server/src/api.ts` already defaults true. Explicit false remains supported for intentional lazy callers and old retries. |
| Agent control `companion_create` | `control-product.ts` already explicitly requests preparation using the durable command ID. |
| Delivery redemption | `delivery.ts` already inserts `prepare_requested=true`; replay returns the existing copy. Copied specialist profiles are templates until used. |
| Specialist draft create/reopen, improvement apply | `specialist-drafts.ts` requests durable configuration admission; capacity queues are preserved. Draft creation already includes its explicit configuration conversation. |
| Replica/mission and specialist test | `delegation.ts` / `specialist-runtime.ts` persist machine, run and admission together. Preparation starts when admitted. |
| Publication image | Capture admission and archive/sanitation stages already advance without a chat message; not a first-response path. |
| Local and Box | Both use the same durable preparation intent; provider adapters and Box create keys are unchanged. |

No further runtime optimization was justified by this audit. Async lifecycle
coordination already keeps slow starts from blocking warm chats and coalesces
in-flight preparation. A healthy first message reuses the prepared endpoint;
health/admission and configuration checks are retained.

Local measurements used the real API, PostgreSQL, executor and compiled Pi daemon
inside isolated Docker Linux containers, with Pi's scripted model. One sample per
case, in the order below; these are illustrative timings, not a Box benchmark or
statistical latency claim. Old/new behavior was selected by sending false/true.

| Mode | Creation POST | Creation → persisted ready | Message → first observed assistant text |
| --- | ---: | ---: | ---: |
| Before, immediate message | 25.9 ms | 1,701 ms | 2,399.9 ms |
| After, immediate message | 10.5 ms | 1,325 ms | 2,330.4 ms |
| Before, message after 5 s | 6.0 ms | 6,381 ms | 2,392.2 ms |
| After, message after 5 s | 7.1 ms | 1,319 ms | 832.9 ms |

POST timing is client wall time. Ready timing uses persisted `createdAt` and
`readyAt`. First text is observed through the API at a 50 ms polling interval,
including admission and observation delay, rather than a provider-level first-token
measurement. Each case had zero runs before the explicit message. The last case
was already ready before the message. All four owned machines were retired and
observed archived through the API; the local stack was then stopped with disks retained.
The reproduction probe and raw credential-free measurements are in the ignored
`.context/fast-start/measure.py` and `.context/fast-start/measurements.json`.

Validation completed:

- Baseline `./dev check web`: 222 passing tests, web build passed. The previously
  reported WebCrypto/attachments/palette failures did not reproduce here.
- Changed UI suites plus all `App.test.tsx`: 73/73 passed.
- Final `./dev check web`: 225/225 tests in 27 files, including web TypeScript and build.
- `./dev check server --test creation-preparation`: 6/6 behavior tests, covering both
  providers/profiles, concurrent creation, message arrival during prewarming,
  acknowledgement loss, legacy lazy setup and no hidden runs or duplicate preparation.
- `./dev check server --test lifecycle`: passed, including recovery/cancellation checks.
- `./dev check server`: 447 passed across 62 suites; root TypeScript and agent build passed.
  Two existing opt-in tests were skipped: actual Bun S3/MinIO transfer and the full
  Linux product acceptance path. The four timing probes did execute real local agents.
- `git diff --check`: passed. Verification resource cleanup passed.

Evidence: `.artifacts/verification/f3f5cc4700bb` (baseline web), `998aa2df6140`
(final web), `e84db1c4cdf0` (creation preparation), `ee4e168a0b28` (lifecycle),
`e78233912af4` (server). This is focused/web/server verification, not `./dev check full`.
The VM initially had Python 3.9; local scenario/cleanup commands used installed
Python 3.11 via `python3.11 scripts/dev-cli.py`, the same CLI behind `./dev`.

The supplied historical Box timings remain unremeasured: fresh preparation about
10.5 s, archived wake about 16.4 s, complex first run about 13.8 s. The last number
is a run duration, not demonstrated first-token latency. Starting preparation earlier
can remove some or all machine latency from the message path; an immediate message
on a cold Box can still exceed 10 s. Archived wake and model latency are unchanged.
There may also be earlier idle compute consumption when someone creates without chatting;
existing admission and idle archival policies still apply.

Recommended next step, only after explicit deployment approval: a small isolated Box
canary with the same built runtime and selected production model. Compare fresh
creation with immediate and delayed messages, plus archived resume; record creation
POST, persisted ready, first streamed model text, first UI-visible text and run completion
separately. Use the existing opt-in preparation trace for phase attribution without
logging payloads or credentials. Use simple and representative complex prompts, report
sample count and median/tail latency, then archive every owned Box and verify provider
state while retaining its disk. This canary should decide whether an additional Box
image/service-start optimization is needed to meet the under-10-second objective.
