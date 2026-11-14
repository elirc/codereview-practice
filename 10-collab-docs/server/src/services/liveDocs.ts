import type * as Y from 'yjs';

/** Access to the documents this instance has open in rooms. */
export interface LiveDocs {
  /** Returns this instance's loaded document, if it has one open. */
  openDoc(docId: string): Y.Doc | null;
}

/** Live documents for processes that open no rooms. */
export const noLiveDocs: LiveDocs = {
  openDoc: () => null,
};
