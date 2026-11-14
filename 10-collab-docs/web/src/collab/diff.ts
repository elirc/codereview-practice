export interface TextChange {
  index: number;
  deleteCount: number;
  insert: string;
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Returns the single replacement turning `from` into `to` by common prefix
 * and suffix over UTF-16 code units, keeping surrogate pairs whole, or null if equal.
 */
export function diffText(from: string, to: string): TextChange | null {
  if (from === to) return null;
  const limit = Math.min(from.length, to.length);
  let prefix = 0;
  while (prefix < limit && from.charCodeAt(prefix) === to.charCodeAt(prefix)) prefix += 1;
  if (prefix > 0 && isHigh(from.charCodeAt(prefix - 1))) prefix -= 1;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    from.charCodeAt(from.length - 1 - suffix) === to.charCodeAt(to.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  if (suffix > 0 && isLow(from.charCodeAt(from.length - suffix))) suffix -= 1;
  return {
    index: prefix,
    deleteCount: from.length - prefix - suffix,
    insert: to.slice(prefix, to.length - suffix),
  };
}
