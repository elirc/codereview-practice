import * as Y from 'yjs';

export type DecodedUpdate = ReturnType<typeof Y.decodeUpdate>;

interface Range {
  clock: number;
  len: number;
}

function covers(ranges: Range[], clock: number, len: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (ranges[mid].clock <= clock) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (candidate < 0) return false;
  const range = ranges[candidate];
  return range.clock + range.len >= clock + len;
}

/**
 * Returns true when applying the update to `doc` would change nothing: every
 * struct it carries is already in `doc` and every deletion it lists is already applied.
 */
export function addsNothing(update: Uint8Array, doc: Y.Doc): boolean {
  const decoded: DecodedUpdate = Y.decodeUpdate(Y.diffUpdate(update, Y.encodeStateVector(doc)));
  if (decoded.structs.length > 0) return false;
  if (decoded.ds.clients.size === 0) return true;
  const known = Y.createDeleteSetFromStructStore(doc.store);
  for (const [client, items] of decoded.ds.clients) {
    const ranges = known.clients.get(client);
    if (!ranges) return false;
    for (const item of items) {
      if (!covers(ranges, item.clock, item.len)) return false;
    }
  }
  return true;
}
