import { randomUUID } from "node:crypto";
import type { MemoryMediaStorage } from "@/media/memory-storage";
import { getMediaStorage } from "@/media/storage-provider";
import { ingestUpload } from "@/media/upload";
import { FIXED_NOW } from "./fixtures";

export function memoryStorage(): MemoryMediaStorage {
  return getMediaStorage() as MemoryMediaStorage;
}

/** Stores a file the way the upload route does, bypassing HTTP. */
export async function storeFile(uploadedBy: string, bytes: Uint8Array, filename = "image.png") {
  return ingestUpload({ filename, bytes }, uploadedBy, {
    storage: memoryStorage(),
    now: new Date(FIXED_NOW),
    newId: randomUUID,
  });
}

export function uploadRequest(
  bytes: Uint8Array,
  filename: string,
  headers: Record<string, string> = {},
): Request {
  const form = new FormData();
  form.append("file", new File([bytes], filename, { type: "application/octet-stream" }));
  return new Request("http://localhost/api/media", { method: "POST", body: form, headers });
}

/** A multipart request whose body arrives as a chunked stream with no Content-Length. */
export function streamedUploadRequest(bytes: Uint8Array, filename: string): Request {
  const boundary = `----cms-test-${randomUUID()}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const parts = [head, bytes, tail];
  const chunkSize = 1024 * 1024;

  let part = 0;
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      while (part < parts.length && offset >= parts[part].length) {
        part += 1;
        offset = 0;
      }
      if (part >= parts.length) {
        controller.close();
        return;
      }
      controller.enqueue(parts[part].slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });

  return new Request("http://localhost/api/media", {
    method: "POST",
    body,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    duplex: "half",
  } as RequestInit);
}
