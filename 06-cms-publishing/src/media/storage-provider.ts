import { getEnv } from "@/env";
import { MemoryMediaStorage } from "./memory-storage";
import { S3MediaStorage } from "./s3-storage";
import type { MediaStorage } from "./storage";

let storage: MediaStorage | undefined;

/** The configured storage backend, created once per process. */
export function getMediaStorage(): MediaStorage {
  if (!storage) {
    const env = getEnv();
    storage =
      env.STORAGE_DRIVER === "memory"
        ? new MemoryMediaStorage()
        : new S3MediaStorage({
            endpoint: env.S3_ENDPOINT,
            region: env.S3_REGION,
            bucket: env.S3_BUCKET,
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          });
  }
  return storage;
}
