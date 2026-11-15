import * as Y from 'yjs';

export interface EncodedAnchor {
  start: string;
  end: string;
}

function encodePosition(position: Y.RelativePosition): string {
  let binary = '';
  for (const byte of Y.encodeRelativePosition(position)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Returns the base64 relative positions the API expects for the selection [start, end) of `text`. */
export function selectionAnchor(text: Y.Text, start: number, end: number): EncodedAnchor {
  return {
    start: encodePosition(Y.createRelativePositionFromTypeIndex(text, start)),
    end: encodePosition(Y.createRelativePositionFromTypeIndex(text, end)),
  };
}
