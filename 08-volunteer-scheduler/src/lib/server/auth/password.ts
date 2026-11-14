import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => {
			if (err) reject(err);
			else resolve(key);
		});
	});
}

/** Returns `scrypt$N$r$p$salt$hash` with base64 salt and hash. */
export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const key = await derive(password, salt, COST, BLOCK_SIZE, PARALLELISM);
	return [
		'scrypt',
		COST,
		BLOCK_SIZE,
		PARALLELISM,
		salt.toString('base64'),
		key.toString('base64')
	].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.split('$');
	if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
	const [n, r, p] = parts.slice(1, 4).map(Number);
	if (![n, r, p].every((value) => Number.isInteger(value) && value > 0)) return false;
	const salt = Buffer.from(parts[4], 'base64');
	const expected = Buffer.from(parts[5], 'base64');
	const actual = await derive(password, salt, n, r, p);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;

/** A real hash to verify against when the account does not exist, so timing is uniform. */
export function dummyPasswordHash(): Promise<string> {
	dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
	return dummyHash;
}
