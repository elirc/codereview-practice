import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { quoteOf, resolveAnchor, threadRange } from '../../src/domain/anchors.js';

function setup(content: string) {
  const doc = new Y.Doc();
  const text = doc.getText('content');
  text.insert(0, content);
  return { doc, text };
}

function anchor(text: Y.Text, start: number, end: number) {
  return {
    start: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, start, 0)),
    end: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, end, -1)),
  };
}

function rangeOf(doc: Y.Doc, text: Y.Text, a: { start: Uint8Array; end: Uint8Array }) {
  return threadRange(doc, text, a.start, a.end);
}

describe('anchor resolution', () => {
  it('resolves "world" in "hello world"', () => {
    const { doc, text } = setup('hello world');
    const world = anchor(text, 6, 11);
    expect(resolveAnchor(doc, text, world.start, world.end)).toEqual({ kind: 'ok', start: 6, end: 11 });
  });

  it('shifts when text is inserted before the range', () => {
    const { doc, text } = setup('hello world');
    const world = anchor(text, 6, 11);
    text.insert(0, '>> ');
    expect(rangeOf(doc, text, world)).toEqual({ range: { start: 9, end: 14 }, detached: false });
  });

  it('extends when text is inserted inside the range', () => {
    const { doc, text } = setup('hello world');
    const world = anchor(text, 6, 11);
    text.insert(8, 'RR');
    expect(rangeOf(doc, text, world).range).toEqual({ start: 6, end: 13 });
  });

  it('does not extend when typing directly after the last character or before the first', () => {
    const { doc, text } = setup('hello world');
    const world = anchor(text, 6, 11);
    text.insert(11, '!!');
    expect(rangeOf(doc, text, world).range).toEqual({ start: 6, end: 11 });
    text.insert(6, '__');
    expect(rangeOf(doc, text, world).range).toEqual({ start: 8, end: 13 });
    expect(text.toString().slice(8, 13)).toBe('world');
  });

  it('detaches when all anchored text is deleted and stays detached after retyping it', () => {
    const { doc, text } = setup('hello world');
    const world = anchor(text, 6, 11);
    text.delete(6, 5);
    expect(rangeOf(doc, text, world).detached).toBe(true);
    text.insert(6, 'world');
    expect(text.toString()).toBe('hello world');
    expect(rangeOf(doc, text, world).detached).toBe(true);
  });

  it('reports positions from a state the document has not seen as unknown', () => {
    const { doc, text } = setup('hello');
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    other.getText('content').insert(5, ' there');
    const ahead = anchor(other.getText('content'), 6, 11);
    expect(resolveAnchor(doc, text, ahead.start, ahead.end)).toEqual({ kind: 'unknown' });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    expect(resolveAnchor(doc, text, ahead.start, ahead.end)).toEqual({ kind: 'ok', start: 6, end: 11 });
  });

  it('treats positions in another type as foreign', () => {
    const { doc, text } = setup('hello');
    const other = doc.getText('elsewhere');
    other.insert(0, 'abc');
    const foreign = anchor(other, 0, 2);
    expect(resolveAnchor(doc, text, foreign.start, foreign.end)).toEqual({ kind: 'foreign' });
  });

  it('gives equal positions for an empty selection', () => {
    const { doc, text } = setup('hello');
    const empty = anchor(text, 2, 2);
    const result = resolveAnchor(doc, text, empty.start, empty.end);
    expect(result.kind === 'ok' && result.start >= result.end).toBe(true);
  });
});

describe('quoteOf', () => {
  it('takes at most 200 code units', () => {
    expect(quoteOf('a'.repeat(300), 0, 300)).toHaveLength(200);
    expect(quoteOf('hello world', 6, 11)).toBe('world');
  });

  it('never ends on half of a surrogate pair', () => {
    const content = 'a'.repeat(199) + '😀' + 'tail';
    expect(quoteOf(content, 0, content.length)).toBe('a'.repeat(199));
  });
});
