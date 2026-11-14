const MAX_FILENAME_LENGTH = 200;
const FALLBACK_FILENAME = "file";

function isControlCharacter(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/** Reduces a client-supplied filename to a safe display name. Never used for storage keys. */
export function sanitizeFilename(raw: string): string {
  const segments = raw.split(/[/\\]/);
  const last = (segments[segments.length - 1] ?? "").normalize("NFC");
  const cleaned = Array.from(last)
    .filter((char) => !isControlCharacter(char))
    .join("")
    .trim();
  const capped = Array.from(cleaned).slice(0, MAX_FILENAME_LENGTH).join("").trim();
  return capped === "" ? FALLBACK_FILENAME : capped;
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** A Content-Disposition header value with an ASCII fallback and an RFC 5987 UTF-8 filename. */
export function contentDisposition(type: "inline" | "attachment", filename: string): string {
  const name = sanitizeFilename(filename);
  const asciiFallback = Array.from(name)
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || code > 0x7e || char === '"' || char === "\\" || char === "%"
        ? "_"
        : char;
    })
    .join("");
  return `${type}; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}
