import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { db } from "./store";
import { createObjectStorage, type ObjectStorage } from "./storage";

export const FILE_MAX_BYTES = 10 * 1024 * 1024;
export const FILE_MAX_COUNT = 5;
export const FILE_REQUEST_MAX_BYTES = FILE_MAX_BYTES + 256 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_TYPES = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf",
  "text/plain", "text/csv", "text/markdown", "application/json",
]);
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

type FilesDatabase = Pick<SQL, "unsafe">;

export interface Attachment {
  id: string;
  clientFileId: string;
  companionId: string;
  runId: string;
  kind: "user_upload" | "agent_output";
  position: number;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  createdAt: string;
}

interface StoredAttachment extends Attachment {
  ownerId: string;
  storageKey: string;
}

export interface AgentFile {
  attachment: Attachment;
  path: string;
  bytes: Uint8Array;
}

export interface ThreadFile {
  id: string;
  runId: string;
  kind: Attachment["kind"];
  name: string;
  mimeType: string;
  size: number;
  url: string;
}

export interface StoreAttachmentInput {
  ownerId: string;
  companionId: string;
  runId: string;
  clientFileId: string;
  position: number;
  filename: string;
  declaredContentType?: string;
  bytes: Uint8Array;
}

export interface FilesDependencies {
  database?: FilesDatabase;
  storage?: ObjectStorage;
}

export class FileRequestError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

const selectColumns = `id,client_file_id AS "clientFileId",owner_id AS "ownerId",companion_id AS "companionId",
  run_id AS "runId",kind,position,filename,content_type AS "contentType",byte_size AS "byteSize",sha256,
  storage_key AS "storageKey",created_at AS "createdAt"`;
const joinedSelectColumns = `a.id,a.client_file_id AS "clientFileId",a.owner_id AS "ownerId",a.companion_id AS "companionId",
  a.run_id AS "runId",a.kind,a.position,a.filename,a.content_type AS "contentType",a.byte_size AS "byteSize",a.sha256,
  a.storage_key AS "storageKey",a.created_at AS "createdAt"`;

export async function migrateFiles(database: FilesDatabase = db) {
  const schema = await Bun.file(new URL("./storage-schema.sql", import.meta.url)).text();
  if (database === db) {
    await db.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(721440139)`;
      await tx.unsafe(schema);
    });
    return;
  }
  await database.unsafe(schema);
}

export function sanitizeFilename(filename: string, position: number, contentType: string) {
  const extension = ({
    "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
    "application/pdf": ".pdf", "text/plain": ".txt", "text/csv": ".csv",
    "text/markdown": ".md", "application/json": ".json",
  } as Record<string, string>)[contentType] ?? ".bin";
  const leaf = filename.normalize("NFKC").split(/[\\/]/).pop() ?? "";
  let safe = leaf.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/\s+/g, "_").replace(/^\.+/, "").slice(0, 120);
  if (!safe || safe === "." || safe === "..") safe = `file-${position + 1}${extension}`;
  if (!safe.includes(".")) safe = `${safe}${extension}`;
  return safe.slice(0, 120);
}

function starts(bytes: Uint8Array, expected: number[]) {
  return expected.every((value, index) => bytes[index] === value);
}

export function sniffContentType(bytes: Uint8Array, declaredContentType: string, filename: string): string | null {
  const declared = declaredContentType.toLowerCase().split(";", 1)[0].trim();
  let binary: string | null = null;
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) binary = "image/png";
  else if (starts(bytes, [0xff, 0xd8, 0xff])) binary = "image/jpeg";
  else if (new TextDecoder().decode(bytes.subarray(0, 6)) === "GIF87a" || new TextDecoder().decode(bytes.subarray(0, 6)) === "GIF89a") binary = "image/gif";
  else if (new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP") binary = "image/webp";
  else if (new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-") binary = "application/pdf";
  if (binary) return !ALLOWED_TYPES.has(declared) || declared === "application/octet-stream" || declared === binary ? binary : null;
  if (declared.startsWith("image/") || declared === "application/pdf") return null;

  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
  if (/[^\t\n\r\x20-\x7e\x80-\u{10ffff}]/u.test(text)) return null;
  const lowerName = filename.toLowerCase();
  if (declared === "application/json" || lowerName.endsWith(".json")) {
    try { JSON.parse(text); return "application/json"; } catch { return null; }
  }
  if (declared === "text/csv" || lowerName.endsWith(".csv")) return "text/csv";
  if (declared === "text/markdown" || lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) return "text/markdown";
  if (declared === "text/plain" || !declared || declared === "application/octet-stream" || lowerName.endsWith(".txt")) return "text/plain";
  return null;
}

interface OwnedRun {
  id: string;
  status: string;
  dispatched: boolean;
  attachmentCount: number;
}

async function ownedRun(database: FilesDatabase, ownerId: string, companionId: string, runId: string): Promise<OwnedRun | null> {
  const rows = await database.unsafe(
    `SELECT r.id,r.status,r.dispatched,r.attachment_count AS "attachmentCount" FROM runs r JOIN companions c ON c.id=r.companion_id
     WHERE r.id=$1 AND r.companion_id=$2 AND c.owner_id=$3`,
    [runId, companionId, ownerId],
  ) as OwnedRun[];
  return rows[0] ?? null;
}

function publicAttachment(row: StoredAttachment): Attachment {
  const { ownerId: _, storageKey: __, ...attachment } = row;
  return attachment;
}

async function storeAttachment(
  input: StoreAttachmentInput,
  kind: Attachment["kind"],
  dependencies: FilesDependencies = {},
): Promise<Attachment> {
  const database = dependencies.database ?? db;
  if (!input.ownerId || !UUID.test(input.companionId) || !UUID.test(input.runId) || !UUID.test(input.clientFileId)) {
    throw new FileRequestError("Invalid file identity.", 400);
  }
  if (!Number.isInteger(input.position) || input.position < 0 || input.position >= FILE_MAX_COUNT) {
    throw new FileRequestError(`A task accepts at most ${FILE_MAX_COUNT} files.`, 400);
  }
  if (!input.bytes.byteLength || input.bytes.byteLength > FILE_MAX_BYTES) {
    throw new FileRequestError(`Each file must be between 1 byte and ${FILE_MAX_BYTES / 1024 / 1024} MB.`, 400);
  }
  const run = await ownedRun(database, input.ownerId, input.companionId, input.runId);
  if (!run) {
    throw new FileRequestError("Task not found.", 404);
  }
  const contentType = sniffContentType(input.bytes, input.declaredContentType ?? "", input.filename);
  if (!contentType) throw new FileRequestError("This file type is not supported.", 400);
  const filename = sanitizeFilename(input.filename, input.position, contentType);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const existingRows = await database.unsafe(
    `SELECT ${selectColumns} FROM attachments WHERE owner_id=$1 AND companion_id=$2 AND run_id=$3 AND client_file_id=$4`,
    [input.ownerId, input.companionId, input.runId, input.clientFileId],
  ) as StoredAttachment[];
  const existing = existingRows[0];
  if (existing) {
    if (existing.sha256 !== sha256 || existing.position !== input.position || existing.kind !== kind) {
      throw new FileRequestError("This file identifier was already used with different content.", 409);
    }
    return publicAttachment(existing);
  }
  if (kind === "user_upload" && (
    run.dispatched
    || run.status !== "queued"
    || input.position >= run.attachmentCount
  )) {
    throw new FileRequestError("This task is not waiting for that file.", 409);
  }
  if (kind === "agent_output" && (!run.dispatched || run.status !== "running")) {
    throw new FileRequestError("This task is not accepting agent files.", 409);
  }

  const storage = dependencies.storage ?? createObjectStorage();
  const ownerHash = createHash("sha256").update(input.ownerId).digest("hex").slice(0, 24);
  const storageKey = `attachments/${ownerHash}/${input.companionId}/${input.runId}/${input.clientFileId}-${sha256}`;
  const id = crypto.randomUUID();
  await storage.put(storageKey, input.bytes, contentType);
  try {
    const rows = await database.unsafe(
      `INSERT INTO attachments (id,client_file_id,owner_id,companion_id,run_id,kind,position,filename,content_type,byte_size,sha256,storage_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${selectColumns}`,
      [id, input.clientFileId, input.ownerId, input.companionId, input.runId, kind, input.position, filename, contentType, input.bytes.byteLength, sha256, storageKey],
    ) as StoredAttachment[];
    return publicAttachment(rows[0]);
  } catch (error) {
    let accepted: StoredAttachment[] = [];
    try {
      accepted = await database.unsafe(
        `SELECT ${selectColumns} FROM attachments WHERE owner_id=$1 AND companion_id=$2 AND run_id=$3 AND client_file_id=$4`,
        [input.ownerId, input.companionId, input.runId, input.clientFileId],
      ) as StoredAttachment[];
    } catch {
      // Preserve the insert failure and still attempt to remove the unreferenced object.
    }
    if (accepted[0]?.storageKey === storageKey) return publicAttachment(accepted[0]);
    await storage.delete(storageKey).catch(() => undefined);
    throw error;
  }
}

export function storeAgentOutput(input: StoreAttachmentInput, dependencies: FilesDependencies = {}) {
  return storeAttachment(input, "agent_output", dependencies);
}

export async function filesForAgent(
  scope: Pick<StoreAttachmentInput, "ownerId" | "companionId" | "runId">,
  dependencies: FilesDependencies = {},
): Promise<AgentFile[]> {
  const database = dependencies.database ?? db;
  if (!await ownedRun(database, scope.ownerId, scope.companionId, scope.runId)) {
    throw new FileRequestError("Task not found.", 404);
  }
  const storage = dependencies.storage ?? createObjectStorage();
  const rows = await database.unsafe(
    `SELECT ${selectColumns} FROM attachments WHERE owner_id=$1 AND companion_id=$2 AND run_id=$3 AND kind='user_upload' ORDER BY position,id`,
    [scope.ownerId, scope.companionId, scope.runId],
  ) as StoredAttachment[];
  return Promise.all(rows.map(async row => ({
    attachment: publicAttachment(row),
    path: `attachments/${row.position}-${row.filename}`,
    bytes: new Uint8Array(await (await storage.get(row.storageKey)).arrayBuffer()),
  })));
}

function responseFile(attachment: Attachment): ThreadFile {
  return {
    id: attachment.id,
    runId: attachment.runId,
    kind: attachment.kind,
    name: attachment.filename,
    mimeType: attachment.contentType,
    size: attachment.byteSize,
    url: `/api/companions/${attachment.companionId}/files/${attachment.id}`,
  };
}

export async function filesForThread(
  ownerId: string,
  companionId: string,
  dependencies: Pick<FilesDependencies, "database"> = {},
): Promise<ThreadFile[]> {
  if (!ownerId || !UUID.test(companionId)) throw new FileRequestError("Companion not found.", 404);
  const database = dependencies.database ?? db;
  const rows = await database.unsafe(
    `SELECT ${joinedSelectColumns} FROM attachments a JOIN companions c ON c.id=a.companion_id
     WHERE a.companion_id=$1 AND a.owner_id=$2 AND c.owner_id=$2 ORDER BY a.created_at,a.position,a.id`,
    [companionId, ownerId],
  ) as StoredAttachment[];
  return rows.map(responseFile);
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function boundedFormData(request: Request) {
  if (!request.body) throw new FileRequestError("A multipart body is required.", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > FILE_REQUEST_MAX_BYTES) {
      await reader.cancel();
      throw new FileRequestError("File is too large.", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, { method: "POST", headers: request.headers, body: bytes }).formData();
}

export async function handleFiles(
  request: Request,
  userId: string,
  dependencies: FilesDependencies = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  const upload = url.pathname.match(/^\/api\/companions\/([0-9a-f-]+)\/runs\/([0-9a-f-]+)\/files$/i);
  const download = url.pathname.match(/^\/api\/companions\/([0-9a-f-]+)\/files\/([0-9a-f-]+)$/i);
  if (!upload && !download) return null;
  if (!userId) return json({ error: "Authentication required." }, 401);
  const database = dependencies.database ?? db;
  try {
    if (upload && request.method === "POST") {
      const [companionId, runId] = upload.slice(1);
      if (!UUID.test(companionId) || !UUID.test(runId)) throw new FileRequestError("Invalid file identity.", 400);
      // Authorize before parsing a multipart body, including chunked requests with no Content-Length.
      if (!await ownedRun(database, userId, companionId, runId)) throw new FileRequestError("Task not found.", 404);
      const storage = dependencies.storage ?? createObjectStorage();
      const length = Number(request.headers.get("content-length") ?? 0);
      if (length > FILE_REQUEST_MAX_BYTES) throw new FileRequestError("File is too large.", 413);
      const form = await boundedFormData(request);
      const file = form.get("file");
      const clientFileId = String(form.get("clientFileId") ?? "");
      const positionValue = form.get("position");
      const position = positionValue === null ? Number.NaN : Number(positionValue);
      if (!(file instanceof File)) throw new FileRequestError("A file is required.", 400);
      const attachment = await storeAttachment({
        ownerId: userId, companionId, runId, clientFileId, position,
        filename: file.name, declaredContentType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      }, "user_upload", { database, storage });
      return json({ file: responseFile(attachment) }, 201);
    }
    if (download && request.method === "GET") {
      const [companionId, fileId] = download.slice(1);
      if (!UUID.test(companionId) || !UUID.test(fileId)) throw new FileRequestError("File not found.", 404);
      const rows = await database.unsafe(
        `SELECT ${joinedSelectColumns} FROM attachments a JOIN companions c ON c.id=a.companion_id
         WHERE a.id=$1 AND a.companion_id=$2 AND a.owner_id=$3 AND c.owner_id=$3`,
        [fileId, companionId, userId],
      ) as StoredAttachment[];
      const attachment = rows[0];
      if (!attachment) throw new FileRequestError("File not found.", 404);
      const storage = dependencies.storage ?? createObjectStorage();
      let blob: Blob;
      try { blob = await storage.get(attachment.storageKey); }
      catch { throw new FileRequestError("File not found.", 404); }
      const disposition = INLINE_TYPES.has(attachment.contentType) ? "inline" : "attachment";
      return new Response(blob, { headers: {
        "Content-Type": attachment.contentType,
        "Content-Length": String(attachment.byteSize),
        "Content-Disposition": `${disposition}; filename="${attachment.filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      } });
    }
    return json({ error: "Method not allowed." }, 405);
  } catch (error) {
    if (error instanceof FileRequestError) return json({ error: error.message }, error.status);
    if (error instanceof SyntaxError || error instanceof TypeError) return json({ error: "Invalid file request." }, 400);
    console.error("file_request_failed");
    return json({ error: "The file could not be stored. Please try again." }, 500);
  }
}
