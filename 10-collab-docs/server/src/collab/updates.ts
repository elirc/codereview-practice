import * as Y from 'yjs';

export type DecodedUpdate = ReturnType<typeof Y.decodeUpdate>;

/** Returns whether every struct of `client` in [clock, clock + len) exists in `doc` and is deleted. */
function rangeDeleted(doc: Y.Doc, client: number, clock: number, len: number): boolean {
  const structs = doc.store.clients.get(client);
  if (!structs || structs.length === 0) return false;
  const last = structs[structs.length - 1];
  const end = clock + len;
  if (last.id.clock + last.length < end) return false;
  let index = Y.findIndexSS(structs, clock);
  let position = clock;
  while (position < end) {
    const struct = structs[index];
    if (!struct.deleted) return false;
    position = struct.id.clock + struct.length;
    index += 1;
  }
  return true;
}

/**
 * Returns true when applying the update to `doc` would change nothing: every
 * struct it carries is already in `doc` and every deletion it lists is already applied.
 */
export function addsNothing(update: Uint8Array, doc: Y.Doc): boolean {
  const decoded: DecodedUpdate = Y.decodeUpdate(Y.diffUpdate(update, Y.encodeStateVector(doc)));
  if (decoded.structs.length > 0) return false;
  for (const [client, items] of decoded.ds.clients) {
    for (const item of items) {
      if (item.len > 0 && !rangeDeleted(doc, client, item.clock, item.len)) return false;
    }
  }
  return true;
}

/** Returns whether the update can be applied to a fresh document without an error. */
export function appliesCleanly(update: Uint8Array): boolean {
  const scratch = new Y.Doc();
  try {
    Y.applyUpdate(scratch, update);
    return true;
  } catch {
    return false;
  } finally {
    scratch.destroy();
  }
}

export type InboundUpdate = 'store' | 'unchanged' | 'too_large' | 'malformed';

/**
 * Classifies an update received from a client against the room's document:
 * `store` when it should be appended, `unchanged` when it adds nothing,
 * `too_large` when it is over `maxBytes`, `malformed` when it cannot be used.
 */
export function classifyInbound(update: Uint8Array, doc: Y.Doc, maxBytes: number): InboundUpdate {
  try {
    Y.decodeUpdate(update);
    if (addsNothing(update, doc)) return 'unchanged';
  } catch {
    return 'malformed';
  }
  if (update.byteLength > maxBytes) return 'too_large';
  return appliesCleanly(update) ? 'store' : 'malformed';
}

/** Applies an update, returning false instead of throwing when it cannot be applied. */
export function tryApplyUpdate(doc: Y.Doc, update: Uint8Array, origin?: unknown): boolean {
  try {
    Y.applyUpdate(doc, update, origin);
    return true;
  } catch {
    return false;
  }
}
