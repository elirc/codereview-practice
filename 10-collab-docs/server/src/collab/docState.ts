import * as Y from 'yjs';
import type { DocLog } from './docStore.js';
import { tryApplyUpdate } from './updates.js';

export const CONTENT_FIELD = 'content';

/** Returns the document's text type. */
export function contentOf(doc: Y.Doc): Y.Text {
  return doc.getText(CONTENT_FIELD);
}

/** Builds a fresh Y.Doc from a snapshot and the updates after it, skipping any that cannot be applied. */
export function docFromLog(log: DocLog, uptoSeq = Number.POSITIVE_INFINITY): Y.Doc {
  const doc = new Y.Doc();
  if (log.snapshot) tryApplyUpdate(doc, log.snapshot.state);
  for (const entry of log.updates) {
    if (entry.seq <= uptoSeq) tryApplyUpdate(doc, entry.update);
  }
  return doc;
}

/** Returns the full state of a log as a single update, plus its text. */
export function stateOfLog(log: DocLog): { state: Uint8Array; text: string } {
  const doc = docFromLog(log);
  try {
    return { state: Y.encodeStateAsUpdate(doc), text: contentOf(doc).toString() };
  } finally {
    doc.destroy();
  }
}

/** Returns the text stored in a full-state update. */
export function textOfState(state: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return contentOf(doc).toString();
  } finally {
    doc.destroy();
  }
}
