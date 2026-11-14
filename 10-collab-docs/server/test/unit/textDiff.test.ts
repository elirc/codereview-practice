import { describe, expect, it } from 'vitest';
import { applyChange, diffText } from '../../src/domain/textDiff.js';

function roundTrip(from: string, to: string) {
  const change = diffText(from, to);
  expect(change).not.toBeNull();
  expect(applyChange(from, change!)).toBe(to);
  return change!;
}

const hasLoneSurrogate = (text: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

describe('diffText', () => {
  it('returns null for equal strings', () => {
    expect(diffText('same', 'same')).toBeNull();
  });

  it('finds an insertion, a deletion and a replacement', () => {
    expect(roundTrip('hello world', 'hello brave world')).toEqual({
      index: 6,
      deleteCount: 0,
      insert: 'brave ',
    });
    expect(roundTrip('hello brave world', 'hello world')).toEqual({
      index: 6,
      deleteCount: 6,
      insert: '',
    });
    expect(roundTrip('the cat sat', 'the dog sat')).toEqual({ index: 4, deleteCount: 3, insert: 'dog' });
  });

  it('handles repeated characters without overlapping prefix and suffix', () => {
    expect(roundTrip('aaa', 'aaaa')).toEqual({ index: 3, deleteCount: 0, insert: 'a' });
    expect(roundTrip('abab', 'ab')).toEqual({ index: 2, deleteCount: 2, insert: '' });
    roundTrip('', 'new');
    roundTrip('old', '');
  });

  it('never splits a surrogate pair at the start of the change', () => {
    const change = roundTrip('a😀b', 'a😃b');
    expect(change.index).toBe(1);
    expect(hasLoneSurrogate(change.insert)).toBe(false);
    expect(change.insert).toBe('😃');
  });

  it('never splits a surrogate pair at the end of the change', () => {
    const from = 'x😀';
    const to = 'x🨀';
    const change = roundTrip(from, to);
    expect(change.deleteCount).toBe(2);
    expect(change.insert).toBe(to.slice(1));
  });

  it('keeps emoji next to the changed range intact', () => {
    const change = roundTrip('😀 start 😀', '😀 middle 😀');
    expect(hasLoneSurrogate(change.insert)).toBe(false);
    expect(change.index).toBe(3);
  });
});
