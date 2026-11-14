import { createHash } from "node:crypto";
import type { Media } from "@/db/schema";
import { logger } from "@/logger";
import { DomainError } from "@/services/errors";
import { insertMedia } from "@/services/media";
import { readImageDimensions } from "./dimensions";
import { sanitizeFilename } from "./filename";
import { buildStorageKey } from "./keys";
import { sniffMediaType } from "./sniff";
import type { MediaStorage } from "./storage";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
// Room for the multipart boundary, part headers and a long filename around the file itself.
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES;

export type UploadedFile = { filename: string; bytes: Uint8Array };

function fileTooLarge(): DomainError {
  return new DomainError("file_too_large", "Files can be at most 10 MiB.", {
    maxBytes: MAX_UPLOAD_BYTES,
  });
}

function missingFile(message: string): DomainError {
  return new DomainError("validation_failed", message, {
    fields: [{ path: "file", message: "Required" }],
  });
}

async function readWithLimit(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw fileTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Reads the `file` field of a multipart request, counting bytes as they arrive. */
export async function readUploadedFile(request: Request): Promise<UploadedFile> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw missingFile("Send the file as multipart/form-data in a field named file.");
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw fileTooLarge();
  }
  if (!request.body) throw missingFile("The request has no body.");

  const raw = await readWithLimit(request.body, MAX_REQUEST_BYTES);
  let form: FormData;
  try {
    form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw missingFile("The multipart body could not be read.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) throw missingFile("Attach a file in the field named file.");
  if (file.size > MAX_UPLOAD_BYTES) throw fileTooLarge();
  return { filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/**
 * Validates and stores an uploaded file, then records it. If the database insert fails the
 * stored object is removed again.
 */
export async function ingestUpload(
  file: UploadedFile,
  uploadedBy: string,
  deps: { storage: MediaStorage; now: Date; newId: () => string },
): Promise<Media> {
  if (file.bytes.byteLength > MAX_UPLOAD_BYTES) throw fileTooLarge();
  const sniffed = await sniffMediaType(file.bytes);
  if (!sniffed) {
    throw new DomainError(
      "unsupported_media_type",
      "Only JPEG, PNG, WebP, GIF and PDF files can be uploaded.",
    );
  }

  const id = deps.newId();
  const storageKey = buildStorageKey(deps.now, id, sniffed.ext);
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const dimensions =
    sniffed.mime === "application/pdf" ? null : readImageDimensions(file.bytes, sniffed.mime);

  await deps.storage.put(storageKey, file.bytes, sniffed.mime);
  try {
    return await insertMedia({
      id,
      storageKey,
      originalFilename: sanitizeFilename(file.filename),
      contentType: sniffed.mime,
      sizeBytes: file.bytes.byteLength,
      sha256,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      uploadedBy,
      createdAt: deps.now,
    });
  } catch (err) {
    try {
      await deps.storage.delete(storageKey);
      logger.warn({ storageKey }, "removed stored object after failed media insert");
    } catch (cleanupErr) {
      logger.error({ err: cleanupErr, storageKey }, "could not remove orphaned media object");
    }
    throw err;
  }
}
