# Task attachments

Uploads and ordinary outputs are private to one Companion task. A completed delegated child may
expose its output to the same owner's parent review through an owner-scoped reference to the same
immutable object; there is no file library. Object bytes live in the configured S3-compatible
bucket and PostgreSQL holds the authorization boundary and metadata.

## API integration

The authenticated API calls `handleFiles(request, userId)` after resolving the Better Auth user. The helper returns `null` for unrelated paths and never derives or bypasses authentication itself.

Create a task first with `POST /api/companions/:companionId/messages` and an `attachmentCount` from 0 through 5. For each file, send multipart form data to:

```text
POST /api/companions/:companionId/runs/:runId/files
file=<binary File>
clientFileId=<stable UUID>
position=<zero-based integer>
```

The client must retry an ambiguous upload with the same `clientFileId`, bytes, and position. A successful request returns `201`:

```json
{
  "file": {
    "id": "uuid",
    "runId": "uuid",
    "kind": "user_upload",
    "name": "report.pdf",
    "mimeType": "application/pdf",
    "size": 2048,
    "url": "/api/companions/companion-uuid/files/file-uuid"
  }
}
```

`GET /api/companions/:companionId/files/:fileId` proxies a private object after checking both the
authenticated owner and Companion. It never returns an S3 key or signed URL.
`filesForThread(ownerId, companionId)` returns direct attachments plus retained delegation
references keyed to the parent review run. The API maps direct uploads and outputs to matching
user or assistant messages when those messages exist. Background-run files, including handoffs,
remain in the top-level projection and Activity associates them by `runId`.

`store.migrate()` applies `storage-schema.sql` after account ownership in the canonical migration transaction; `migrateFiles()` remains the focused helper for tests and integration. The runtime must not dispatch a queued task until the stored upload count equals the declared count:

```sql
SELECT count(*)::int
FROM attachments
WHERE owner_id = $1
  AND companion_id = $2
  AND run_id = $3
  AND kind = 'user_upload';
```

A new user upload is accepted only while the task is queued, has not been dispatched, and its position is below `runs.attachment_count`. An already accepted upload remains idempotently retriable after dispatch, which covers a lost HTTP acknowledgement without changing the task. `filesForAgent()` returns that task's user uploads and, for a delegation review, its owner-scoped handed-off child outputs. It verifies the bytes and stages them under `attachments/<position>-<safe-name>`. `storeAgentOutput()` records a bounded file while that exact task is running.

The server accepts up to five files, each from 1 byte through 10 MiB. Supported types are PNG, JPEG, WebP, GIF, PDF, UTF-8 text, CSV, Markdown, and JSON. It checks file signatures or decodes and validates textual formats instead of trusting the browser MIME type. Names are reduced to a safe leaf name. If object upload succeeds but metadata persistence fails, the helper deletes that unreferenced object. Accepted task files remain durable with the thread. Delegation handoffs reference the original attachment and share its object bytes; `ON DELETE RESTRICT` prevents deletion while a parent reference exists. Any future permanent-delete path must transactionally remove or tombstone authorized metadata and enqueue object cleanup only after proving that no attachment or delegation reference remains, then delete the object idempotently after commit. Never delete object bytes before the reference transaction commits.

## Configuration

Hosted deployments provide `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_FILES`, and optionally `S3_REGION`. Objects are private and the Bun S3 client uses path-style requests for MinIO compatibility.

When object storage is not configured, `scripts/dev.py` starts workspace-scoped MinIO and Mailpit containers from digest-pinned images. Ports are derived from the web port: PostgreSQL `+2`, MinIO API `+3`, MinIO console `+4`, SMTP `+5`, and Mailpit UI `+6`. MinIO credentials are generated into the private workspace data directory and are never printed. The launcher exposes `SMTP_HOST=127.0.0.1`, `SMTP_PORT=<base+5>`, and `SMTP_FROM=companions.build <auth@companions.build>` to application processes. Ctrl-C stops only the exact workspace containers and retains their named volumes.

The real MinIO acceptance test remains opt-in for a direct test invocation:

```sh
RUN_STORAGE_ACCEPTANCE=1 bun test apps/server/test/files.test.ts
```

`python3 scripts/verify.py` enables it automatically against a fresh, digest-pinned MinIO
container and private bucket owned by that verification run. The verifier labels PostgreSQL,
MinIO, agent, and short-lived setup containers with its random run identity, then removes only
containers carrying that exact label even when a check fails.
## Delegation handoff

The executor verifies child output durability before creating the parent review. In one fenced
transaction it inserts the review run and `delegation_files` references to the original child
attachments. The review keeps `attachment_count=0` because this count belongs to human uploads;
its delegation source causes the executor to stage the linked files separately. References are
idempotent and do not create new S3 objects.

Parent detail projects each retained attachment under the parent review’s run ID. Its download URL
continues to target the original child attachment and requires the same authenticated owner, even
after the child is archived or retired. Background Activity shows these download links. Source and
parent ownership, file length and SHA-256 are checked before staging.
