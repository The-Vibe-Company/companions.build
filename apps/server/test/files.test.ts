import { describe, expect, test } from "bun:test";
import {
  FILE_REQUEST_MAX_BYTES,
  filesForThread,
  filesForAgent,
  handleFiles,
  sanitizeFilename,
  sniffContentType,
  storeAgentOutput,
} from "../src/files";
import { createObjectStorage } from "../src/storage";

const OWNER = "user-owner";
const OTHER_OWNER = "user-other";
const COMPANION = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const CLIENT_FILE = "33333333-3333-4333-8333-333333333333";

class MemoryStorage {
  objects = new Map<string, Blob>();
  puts = 0;
  async put(key: string, bytes: Uint8Array, contentType: string) {
    this.puts++;
    this.objects.set(key, new Blob([bytes.slice().buffer as ArrayBuffer], { type: contentType }));
  }
  async get(key: string) {
    const value = this.objects.get(key);
    if (!value) throw new Error("missing");
    return value;
  }
  async delete(key: string) { this.objects.delete(key); }
}

class FilesDatabase {
  attachments: any[] = [];
  run = { id: RUN, status: "queued", dispatched: false, attachmentCount: 1 };
  async unsafe(query: string, values: unknown[] = []) {
    if(query.includes("FROM delegation_files"))return [];
    if (query.includes("FROM runs r JOIN companions")) {
      return values[0] === RUN && values[1] === COMPANION && values[2] === OWNER ? [this.run] : [];
    }
    if (query.includes("FROM attachments WHERE") && query.includes("kind='user_upload'")) {
      return this.attachments.filter(row => row.ownerId === values[0] && row.companionId === values[1]
        && row.runId === values[2] && row.kind === "user_upload");
    }
    if (query.includes("FROM attachments WHERE") && query.includes("client_file_id=$4")) {
      return this.attachments.filter(row => row.ownerId === values[0] && row.companionId === values[1]
        && row.runId === values[2] && row.clientFileId === values[3]);
    }
    if (query.startsWith("INSERT INTO attachments")) {
      const [id, clientFileId, ownerId, companionId, runId, kind, position, filename, contentType, byteSize, sha256, storageKey] = values;
      const row = { id, clientFileId, ownerId, companionId, runId, kind, position, filename, contentType, byteSize, sha256, storageKey, createdAt: new Date().toISOString() };
      this.attachments.push(row);
      return [row];
    }
    if (query.includes("FROM attachments a JOIN companions")) {
      if (query.includes("a.id=$1")) {
        return this.attachments.filter(row => row.id === values[0] && row.companionId === values[1]
          && row.ownerId === values[2] && values[2] === OWNER);
      }
      return this.attachments.filter(row => row.companionId === values[0] && row.ownerId === values[1]
        && values[1] === OWNER);
    }
    throw new Error(`Unexpected query: ${query}`);
  }
}

function uploadRequest(file: File, overrides: { owner?: string; clientFileId?: string; position?: number } = {}) {
  const form = new FormData();
  form.set("clientFileId", overrides.clientFileId ?? CLIENT_FILE);
  form.set("position", String(overrides.position ?? 0));
  form.set("file", file);
  return new Request(`http://localhost/api/companions/${COMPANION}/runs/${RUN}/files`, { method: "POST", body: form });
}

describe("task attachments", () => {
  test("sniffs supported bytes and produces a path-safe name", () => {
    expect(sniffContentType(new TextEncoder().encode("%PDF-1.7"), "application/octet-stream", "report.pdf")).toBe("application/pdf");
    expect(sniffContentType(new TextEncoder().encode("not png"), "image/png", "fake.png")).toBeNull();
    expect(sanitizeFilename("../../Q3 résumé.pdf", 0, "application/pdf")).toBe("Q3_r_sum_.pdf");
  });

  test("stores one owner-scoped task file idempotently and serves it through the authenticated route", async () => {
    const database = new FilesDatabase();
    const storage = new MemoryStorage();
    const request = () => uploadRequest(new File([new TextEncoder().encode("%PDF-1.7\nreport")], "../../Q3 report.pdf", { type: "application/pdf" }));

    const first = await handleFiles(request(), OWNER, { database: database as any, storage });
    expect(first?.status).toBe(201);
    const payload = await first!.json() as any;
    expect(payload.file).toMatchObject({ name: "Q3_report.pdf", mimeType: "application/pdf", runId: RUN });
    expect(payload.file).not.toHaveProperty("storageKey");

    const retry = await handleFiles(request(), OWNER, { database: database as any, storage });
    expect(retry?.status).toBe(201);
    expect(storage.puts).toBe(1);

    const denied = await handleFiles(new Request(`http://localhost/api/companions/${COMPANION}/files/${payload.file.id}`), OTHER_OWNER, { database: database as any, storage });
    expect(denied?.status).toBe(404);
    const download = await handleFiles(new Request(`http://localhost/api/companions/${COMPANION}/files/${payload.file.id}`), OWNER, { database: database as any, storage });
    expect(download?.status).toBe(200);
    expect(download?.headers.get("content-disposition")).toBe('attachment; filename="Q3_report.pdf"');
    expect(download?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await download?.text()).toBe("%PDF-1.7\nreport");
  });

  test("authorizes before reading a body and enforces the task's declared count", async () => {
    const database = new FilesDatabase();
    const storage = new MemoryStorage();
    const oversized = new Request(`http://localhost/api/companions/${COMPANION}/runs/${RUN}/files`, {
      method: "POST",
      headers: { "Content-Length": String(FILE_REQUEST_MAX_BYTES + 1) },
    });
    expect((await handleFiles(oversized, OTHER_OWNER, { database: database as any, storage }))?.status).toBe(404);
    expect((await handleFiles(oversized, OWNER, { database: database as any, storage }))?.status).toBe(413);
    expect((await handleFiles(uploadRequest(new File(["two"], "two.txt", { type: "text/plain" }), { position: 1 }), OWNER, { database: database as any, storage }))?.status).toBe(409);
    expect(storage.puts).toBe(0);
  });

  test("removes an uploaded object when metadata persistence fails", async () => {
    class FailingDatabase extends FilesDatabase {
      override async unsafe(query: string, values: unknown[] = []) {
        if (query.startsWith("INSERT INTO attachments")) throw new Error("database unavailable");
        return super.unsafe(query, values);
      }
    }
    const database = new FailingDatabase();
    const storage = new MemoryStorage();
    await expect(handleFiles(
      uploadRequest(new File(["notes"], "notes.txt", { type: "text/plain" })),
      OWNER,
      { database: database as any, storage },
    )).resolves.toMatchObject({ status: 500 });
    expect(storage.objects.size).toBe(0);
  });

  test("preserves uploaded bytes when a failed insert cannot determine whether an attachment committed",async()=>{
    let lookups=0;
    class UncertainDatabase extends FilesDatabase {
      override async unsafe(query:string,values:unknown[]=[]){
        if(query.startsWith("INSERT INTO attachments"))throw Error("insert acknowledgement lost");
        if(query.includes("client_file_id=$4")&&++lookups>1)throw Error("reference lookup unavailable");
        return super.unsafe(query,values);
      }
    }
    const storage=new MemoryStorage();
    const result=await handleFiles(uploadRequest(new File(["retained"],"report.txt",{type:"text/plain"})),OWNER,{database:new UncertainDatabase() as any,storage});
    expect(result?.status).toBe(500);expect(storage.objects.size).toBe(1);
  });

  test("gives the agent only user uploads from its exact task and stores bounded outputs", async () => {
    const database = new FilesDatabase();
    const storage = new MemoryStorage();
    await handleFiles(uploadRequest(new File(["notes"], "notes.txt", { type: "text/plain" })), OWNER, { database: database as any, storage });
    const staged = await filesForAgent({ ownerId: OWNER, companionId: COMPANION, runId: RUN }, { database: database as any, storage });
    expect(staged).toHaveLength(1);
    expect(staged[0].path).toBe("attachments/0-notes.txt");
    expect(new TextDecoder().decode(staged[0].bytes)).toBe("notes");

    database.run.status = "running";
    database.run.dispatched = true;
    const output = await storeAgentOutput({
      ownerId: OWNER, companionId: COMPANION, runId: RUN,
      clientFileId: crypto.randomUUID(), position: 0, filename: "result.json",
      declaredContentType: "application/json", bytes: new TextEncoder().encode('{"ok":true}'),
    }, { database: database as any, storage });
    expect(output).toMatchObject({ kind: "agent_output", contentType: "application/json" });
    expect(await filesForAgent({ ownerId: OWNER, companionId: COMPANION, runId: RUN }, { database: database as any, storage })).toHaveLength(1);
    expect(await filesForThread(OWNER, COMPANION, { database: database as any })).toEqual([
      expect.objectContaining({ runId: RUN, kind: "user_upload", name: "notes.txt", size: 5 }),
      expect.objectContaining({ runId: RUN, kind: "agent_output", name: "result.json", size: 11 }),
    ]);
  });
});

test.skipIf(process.env.RUN_STORAGE_ACCEPTANCE !== "1")("Bun S3 client writes, downloads and deletes an actual MinIO object", async () => {
  const storage = createObjectStorage();
  const key = `acceptance/${crypto.randomUUID()}.txt`;
  try {
    await storage.put(key, new TextEncoder().encode("actual MinIO bytes"), "text/plain");
    expect(await (await storage.get(key)).text()).toBe("actual MinIO bytes");
  } finally {
    await storage.delete(key);
  }
  await expect(storage.get(key)).rejects.toThrow();
});
