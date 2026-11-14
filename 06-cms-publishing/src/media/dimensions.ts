import type { AllowedMediaType } from "./sniff";

export type Dimensions = { width: number; height: number };

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function png(view: DataView, bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function gif(view: DataView): Dimensions | null {
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function jpeg(view: DataView, bytes: Uint8Array): Dimensions | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    offset += 2 + view.getUint16(offset + 2);
  }
  return null;
}

function webp(view: DataView, bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    return null;
  }
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return { width, height };
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  return null;
}

/** Reads image dimensions from header bytes. Returns null when they cannot be determined. */
export function readImageDimensions(bytes: Uint8Array, mime: AllowedMediaType): Dimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    let result: Dimensions | null;
    switch (mime) {
      case "image/png":
        result = png(view, bytes);
        break;
      case "image/gif":
        result = bytes.length >= 10 ? gif(view) : null;
        break;
      case "image/jpeg":
        result = jpeg(view, bytes);
        break;
      case "image/webp":
        result = webp(view, bytes);
        break;
      default:
        result = null;
    }
    if (!result || result.width <= 0 || result.height <= 0) return null;
    return result;
  } catch (err) {
    if (err instanceof RangeError) return null;
    throw err;
  }
}
