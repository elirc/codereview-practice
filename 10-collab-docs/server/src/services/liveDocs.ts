import type * as Y from 'yjs';

/** Access to the documents this instance has open in rooms. */
export interface LiveDocs {
  /** Returns this instance's loaded document, if it has one open. */
  openDoc(docId: string): Y.Doc | null;
  /** Runs `task` in the document's room queue when a room is open, otherwise directly. */
  runExclusive<T>(docId: string, task: () => Promise<T>): Promise<T>;
  /** Integrates a committed server-generated update locally and announces it to other instances. */
  applyCommitted(docId: string, seq: number, update: Uint8Array): void;
}

/** Live documents for processes that open no rooms. */
export const noLiveDocs: LiveDocs = {
  openDoc: () => null,
  runExclusive: (_docId, task) => task(),
  applyCommitted: () => undefined,
};
