import { fileTypeFromBuffer } from "file-type";

export const ALLOWED_MEDIA_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
} as const;

export type AllowedMediaType = keyof typeof ALLOWED_MEDIA_TYPES;
export type MediaExtension = (typeof ALLOWED_MEDIA_TYPES)[AllowedMediaType];
export type SniffedType = { mime: AllowedMediaType; ext: MediaExtension };

function isAllowed(mime: string): mime is AllowedMediaType {
  return Object.hasOwn(ALLOWED_MEDIA_TYPES, mime);
}

/** Detects the file type from its leading bytes. Returns null unless the type is allow-listed. */
export async function sniffMediaType(bytes: Uint8Array): Promise<SniffedType | null> {
  if (bytes.byteLength === 0) return null;
  const detected = await fileTypeFromBuffer(bytes);
  if (!detected || !isAllowed(detected.mime)) return null;
  return { mime: detected.mime, ext: ALLOWED_MEDIA_TYPES[detected.mime] };
}
