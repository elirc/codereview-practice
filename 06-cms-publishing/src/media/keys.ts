import { ALLOWED_MEDIA_TYPES } from "./sniff";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXTENSIONS: ReadonlySet<string> = new Set(Object.values(ALLOWED_MEDIA_TYPES));

/** `media/<yyyy>/<mm>/<id>.<ext>`, built only from server-side values. */
export function buildStorageKey(now: Date, id: string, ext: string): string {
  if (!UUID.test(id)) throw new Error("storage key id must be a lower-case UUID");
  if (!EXTENSIONS.has(ext)) throw new Error(`unsupported storage key extension: ${ext}`);
  const year = String(now.getUTCFullYear()).padStart(4, "0");
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `media/${year}/${month}/${id}.${ext}`;
}
