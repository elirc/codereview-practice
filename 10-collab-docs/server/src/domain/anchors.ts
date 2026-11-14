import * as Y from 'yjs';

export const QUOTE_LIMIT = 200;

export type AnchorResolution =
  | { kind: 'unknown' }
  | { kind: 'foreign' }
  | { kind: 'ok'; start: number; end: number };

export interface ThreadRange {
  range: { start: number; end: number };
  detached: boolean;
}

/** Decodes an encoded relative position; throws on malformed input. */
export function decodeAnchor(bytes: Uint8Array): Y.RelativePosition {
  if (bytes.byteLength === 0) throw new Error('empty anchor');
  return Y.decodeRelativePosition(bytes);
}

function resolveOne(doc: Y.Doc, bytes: Uint8Array): Y.AbsolutePosition | null {
  return Y.createAbsolutePositionFromRelativePosition(decodeAnchor(bytes), doc);
}

/**
 * Resolves a stored start/end anchor pair against `text` in `doc`. Returns
 * `unknown` when either position refers to content the document does not
 * have, and `foreign` when either belongs to another type.
 */
export function resolveAnchor(
  doc: Y.Doc,
  text: Y.Text,
  start: Uint8Array,
  end: Uint8Array,
): AnchorResolution {
  const from = resolveOne(doc, start);
  const to = resolveOne(doc, end);
  if (from === null || to === null) return { kind: 'unknown' };
  if (from.type !== text || to.type !== text) return { kind: 'foreign' };
  return { kind: 'ok', start: from.index, end: to.index };
}

/** Returns a thread's current range and whether it is detached from its text. */
export function threadRange(doc: Y.Doc, text: Y.Text, start: Uint8Array, end: Uint8Array): ThreadRange {
  let resolution: AnchorResolution;
  try {
    resolution = resolveAnchor(doc, text, start, end);
  } catch {
    resolution = { kind: 'unknown' };
  }
  if (resolution.kind !== 'ok') return { range: { start: 0, end: 0 }, detached: true };
  return {
    range: { start: resolution.start, end: resolution.end },
    detached: resolution.start >= resolution.end,
  };
}

/** Returns the first QUOTE_LIMIT UTF-16 code units of the range without splitting a surrogate pair. */
export function quoteOf(content: string, start: number, end: number): string {
  let quote = content.slice(start, Math.min(end, start + QUOTE_LIMIT));
  const last = quote.charCodeAt(quote.length - 1);
  if (quote.length > 0 && last >= 0xd800 && last <= 0xdbff) quote = quote.slice(0, -1);
  return quote;
}
