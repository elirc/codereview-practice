import type { Media } from "@/db/schema";
import { contentDisposition } from "./filename";

/** Response headers for serving a stored media object. */
export function mediaResponseHeaders(
  media: Pick<Media, "contentType" | "originalFilename">,
  isPublic: boolean,
): Headers {
  const disposition = media.contentType === "application/pdf" ? "attachment" : "inline";
  return new Headers({
    "Content-Type": media.contentType,
    "Content-Disposition": contentDisposition(disposition, media.originalFilename),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": isPublic ? "public, max-age=60" : "private, no-store",
  });
}
