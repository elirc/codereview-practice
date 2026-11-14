import { createHash, randomBytes, randomUUID } from 'node:crypto';

export interface RandomSource {
  /** Returns 32 random bytes encoded as base64url. */
  token(): string;
  /** Returns a random UUID. */
  uuid(): string;
}

export const cryptoRandom: RandomSource = {
  token: () => randomBytes(32).toString('base64url'),
  uuid: () => randomUUID(),
};

/** Returns the lower-case hex SHA-256 digest of a string. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
