export interface TextChange {
  /** UTF-16 index where the replaced range starts. */
  index: number;
  /** Number of UTF-16 code units removed at `index`. */
  deleteCount: number;
  /** Text inserted at `index`. */
  insert: string;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Returns the single replacement that turns `from` into `to`, found by common
 * prefix and suffix over UTF-16 code units without splitting a surrogate pair,
 * or null when the strings are equal.
 */
export function diffText(from: string, to: string): TextChange | null {
  if (from === to) return null;
  const limit = Math.min(from.length, to.length);

  let prefix = 0;
  while (prefix < limit && from.charCodeAt(prefix) === to.charCodeAt(prefix)) prefix += 1;
  if (prefix > 0 && isHighSurrogate(from.charCodeAt(prefix - 1))) prefix -= 1;

  let suffix = 0;
  while (
    suffix < limit - prefix &&
    from.charCodeAt(from.length - 1 - suffix) === to.charCodeAt(to.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  if (suffix > 0 && isLowSurrogate(from.charCodeAt(from.length - suffix))) suffix -= 1;

  return {
    index: prefix,
    deleteCount: from.length - prefix - suffix,
    insert: to.slice(prefix, to.length - suffix),
  };
}

/** Applies a change to a string. */
export function applyChange(text: string, change: TextChange): string {
  return text.slice(0, change.index) + change.insert + text.slice(change.index + change.deleteCount);
}
