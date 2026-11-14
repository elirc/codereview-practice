import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../../src/domain/tokenBucket.js';

describe('TokenBucket', () => {
  it('allows a full burst and refuses the next take at the same instant', () => {
    const bucket = new TokenBucket(50, 100, 0);
    for (let i = 0; i < 100; i += 1) expect(bucket.take(0)).toBe(true);
    expect(bucket.take(0)).toBe(false);
  });

  it('refills at the configured rate', () => {
    const bucket = new TokenBucket(50, 100, 0);
    for (let i = 0; i < 100; i += 1) bucket.take(0);
    expect(bucket.take(19)).toBe(false);
    expect(bucket.take(21)).toBe(true);
    expect(bucket.take(21)).toBe(false);
    let allowed = 0;
    for (let i = 0; i < 60; i += 1) if (bucket.take(1021)) allowed += 1;
    expect(allowed).toBe(50);
  });

  it('never holds more than its capacity', () => {
    const bucket = new TokenBucket(50, 100, 0);
    let allowed = 0;
    for (let i = 0; i < 200; i += 1) if (bucket.take(60_000)) allowed += 1;
    expect(allowed).toBe(100);
  });

  it('ignores a clock that moves backwards', () => {
    const bucket = new TokenBucket(1, 1, 1_000);
    expect(bucket.take(1_000)).toBe(true);
    expect(bucket.take(0)).toBe(false);
  });
});
