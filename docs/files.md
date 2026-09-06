# Task attachments

Attachments are private files on one Companion task. They appear only in that durable thread; there is no file library. Object bytes live in the configured S3-compatible bucket and PostgreSQL holds the authorization boundary and metadata.

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

`GET /api/companions/:companionId/files/:fileId` proxies a private object after checking both the authenticated owner and Companion. It never returns an S3 key or signed URL. `filesForThread(ownerId, companionId)` returns the same projection, including both `user_upload` and `agent_output`, for the API to attach to its message/run detail response. Associate `user_upload` with the user message for the matching `runId`; associate `agent_output` with the assistant message.

Run `migrateFiles()` after the accounts migration, because `storage-schema.sql` references `companions.owner_id` and `runs.attachment_count`. The runtime must not dispatch a queued task until this count equals the declared count:

```sql
SELECT count(*)::int
FROM attachments
WHERE owner_id = $1
  AND companion_id = $2
  AND run_id = $3
  AND kind = 'user_upload';
```

A new user upload is accepted only while the task is queued, has not been dispatched, and its position is below `runs.attachment_count`. An already accepted upload remains idempotently retriable after dispatch, which covers a lost HTTP acknowledgement without changing the task. `filesForAgent()` returns only that exact task's user uploads as `attachments/<position>-<safe-name>`. `storeAgentOutput()` records a bounded file while that exact task is running.

The server accepts up to five files, each from 1 byte through 10 MiB. Supported types are PNG, JPEG, WebP, GIF, PDF, UTF-8 text, CSV, Markdown, and JSON. It checks file signatures or decodes and validates textual formats instead of trusting the browser MIME type. Names are reduced to a safe leaf name. If object upload succeeds but metadata persistence fails, the helper deletes that unreferenced object. Accepted task files remain durable with the thread. PostgreSQL metadata follows the task cascade; integration code that permanently deletes tasks must delete their object keys before deleting the rows.

## Configuration

Hosted deployments provide `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_FILES`, and optionally `S3_REGION`. Objects are private and the Bun S3 client uses path-style requests for MinIO compatibility.

When object storage is not configured, `scripts/dev.py` starts workspace-scoped MinIO and Mailpit containers from digest-pinned images. Ports are derived from the web port: PostgreSQL `+2`, MinIO API `+3`, MinIO console `+4`, SMTP `+5`, and Mailpit UI `+6`. MinIO credentials are generated into the private workspace data directory and are never printed. The launcher exposes `SMTP_HOST=127.0.0.1`, `SMTP_PORT=<base+5>`, and `SMTP_FROM=companions.build <auth@companions.build>` to application processes. Ctrl-C stops only the exact workspace containers and retains their named volumes.

The real MinIO acceptance test is opt-in so ordinary tests remain isolated:

```sh
RUN_STORAGE_ACCEPTANCE=1 bun test apps/server/test/files.test.ts
```
