import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { selectionAnchor } from '../src/collab/anchors';

function decode(encoded: string): Y.RelativePosition {
  return Y.decodeRelativePosition(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)));
}

describe('selectionAnchor', () => {
  it('encodes positions that resolve to the selected range', () => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    text.insert(0, 'hello world');
    const anchor = selectionAnchor(text, 6, 11);
    const start = Y.createAbsolutePositionFromRelativePosition(decode(anchor.start), doc);
    const end = Y.createAbsolutePositionFromRelativePosition(decode(anchor.end), doc);
    expect(start?.type).toBe(text);
    expect([start?.index, end?.index]).toEqual([6, 11]);
  });
});
