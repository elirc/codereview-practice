/** Encodes bytes as standard base64. */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** Decodes standard base64 into a fresh byte array; throws on invalid input. */
export function fromBase64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new Error('invalid base64');
  }
  return new Uint8Array(Buffer.from(text, 'base64'));
}
