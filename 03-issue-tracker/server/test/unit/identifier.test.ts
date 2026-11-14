import { describe, expect, it } from 'vitest';
import {
  formatIdentifier,
  isStorableIssueNumber,
  parseIdentifier,
} from '../../src/lib/identifier.js';

describe('issue identifiers', () => {
  it('formats KEY-number', () => {
    expect(formatIdentifier('ENG', 42)).toBe('ENG-42');
  });

  it('parses identifiers case-insensitively', () => {
    expect(parseIdentifier('ENG-42')).toEqual({ key: 'ENG', number: 42 });
    expect(parseIdentifier('eng-12')).toEqual({ key: 'ENG', number: 12 });
    expect(parseIdentifier('Ab-1')).toEqual({ key: 'AB', number: 1 });
    expect(parseIdentifier('ABCDEF-7')).toEqual({ key: 'ABCDEF', number: 7 });
  });

  it('rejects anything that is not exactly KEY-number', () => {
    for (const input of ['E-1', 'ABCDEFG-1', 'ENG-', 'ENG12', 'ENG-1a', ' ENG-1', 'EN1-2', 'ENG--1']) {
      expect(parseIdentifier(input)).toBeNull();
    }
  });

  it('parses numbers too large to store but flags them as unmatchable', () => {
    const parsed = parseIdentifier('ENG-99999999999999999999');
    expect(parsed?.key).toBe('ENG');
    expect(isStorableIssueNumber(parsed?.number ?? 0)).toBe(false);
    expect(isStorableIssueNumber(2_147_483_648)).toBe(false);
    expect(isStorableIssueNumber(0)).toBe(false);
    expect(isStorableIssueNumber(12)).toBe(true);
  });
});
