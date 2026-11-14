/** Minimal byte sequences that look like real files to a content sniffer. */

function bytes(...parts: Array<number[] | string | Uint8Array>): Uint8Array {
  const chunks = parts.map((part) =>
    typeof part === "string"
      ? new TextEncoder().encode(part)
      : part instanceof Uint8Array
        ? part
        : Uint8Array.from(part),
  );
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function be32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function le16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function le24(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
}

/** Pads a file with zero bytes up to `size`. */
export function padTo(file: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set(file.subarray(0, size));
  return out;
}

export function png(width = 3, height = 2): Uint8Array {
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    be32(13),
    "IHDR",
    be32(width),
    be32(height),
    [8, 6, 0, 0, 0],
    [0, 0, 0, 0],
    be32(0),
    "IDAT",
    [0, 0, 0, 0],
  );
}

export function jpeg(width = 640, height = 480): Uint8Array {
  return bytes(
    [0xff, 0xd8],
    [0xff, 0xe0, 0x00, 0x10],
    "JFIF",
    [0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00],
    [0xff, 0xc0, 0x00, 0x11, 0x08],
    [(height >>> 8) & 0xff, height & 0xff, (width >>> 8) & 0xff, width & 0xff],
    [0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01],
    [0xff, 0xd9],
  );
}

export function gif(width = 16, height = 9): Uint8Array {
  return bytes("GIF89a", le16(width), le16(height), [0x00, 0x00, 0x00, 0x3b]);
}

export function webp(width = 800, height = 600): Uint8Array {
  return bytes(
    "RIFF",
    [22, 0, 0, 0],
    "WEBP",
    "VP8X",
    [10, 0, 0, 0],
    [0, 0, 0, 0],
    le24(width - 1),
    le24(height - 1),
  );
}

export function pdf(): Uint8Array {
  return bytes("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n", " ".repeat(1500), "%%EOF\n");
}

export function html(): Uint8Array {
  return bytes("<!DOCTYPE html><html><body><script>alert(1)</script></body></html>");
}

export function svg(): Uint8Array {
  return bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
}

export function xmlSvg(): Uint8Array {
  return bytes('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');
}
