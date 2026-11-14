import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/services/passwords.js';

describe('password hashing', () => {
  it('verifies the original password and rejects others', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batterz', hash)).toBe(false);
  });

  it('salts every hash', async () => {
    const first = await hashPassword('same password');
    const second = await hashPassword('same password');
    expect(first).not.toBe(second);
  });

  it('rejects malformed stored hashes', async () => {
    expect(await verifyPassword('anything', 'plain-text')).toBe(false);
  });
});
