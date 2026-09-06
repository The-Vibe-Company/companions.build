import { S3Client } from "bun";

export interface StorageConfig {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
}

export interface ObjectStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Blob>;
  delete(key: string): Promise<void>;
}

export function getStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const endpoint = env.S3_ENDPOINT;
  const accessKeyId = env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
  const bucket = env.S3_BUCKET_FILES;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("File storage is not configured.");
  }
  const url = new URL(endpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("S3_ENDPOINT must use HTTP or HTTPS.");
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("S3_BUCKET_FILES is invalid.");
  }
  return { endpoint: url.href.replace(/\/$/, ""), accessKeyId, secretAccessKey, bucket, region: env.S3_REGION ?? "us-east-1" };
}

export function createObjectStorage(config = getStorageConfig()): ObjectStorage {
  const client = new S3Client({
    endpoint: config.endpoint,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucket: config.bucket,
    region: config.region,
    virtualHostedStyle: false,
  });
  return {
    async put(key, bytes, contentType) {
      await client.write(key, bytes, { type: contentType, acl: "private" });
    },
    async get(key) {
      const file = client.file(key);
      if (!await file.exists()) throw new Error("object_not_found");
      return file;
    },
    async delete(key) {
      await client.delete(key);
    },
  };
}
