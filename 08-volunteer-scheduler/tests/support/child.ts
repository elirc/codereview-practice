/**
 * Runs one operation against a database file in a separate process, so tests
 * can race real connections. Prints `ready`, waits for a line on stdin, then
 * prints the result as JSON.
 */
import { createInterface } from 'node:readline';
import { pino } from 'pino';
import type { AppContext } from '../../src/lib/server/context';
import { openDatabase } from '../../src/lib/server/db/client';
import { claimBatch } from '../../src/lib/server/outbox/dispatcher';
import { materializeSeriesById } from '../../src/lib/server/services/series';
import { signUp } from '../../src/lib/server/services/signups';

const [op, dbPath, nowArg, ...rest] = process.argv.slice(2);
const { sqlite, db } = openDatabase(dbPath);
const ctx: AppContext = {
	db,
	zone: 'America/New_York',
	now: () => Number(nowArg),
	logger: pino({ level: 'silent' })
};

function perform(): unknown {
	switch (op) {
		case 'signup': {
			const [userId, shiftId] = rest;
			try {
				const signup = signUp(ctx, { userId, shiftId, actor: { id: userId, role: 'volunteer' } });
				return { status: signup.status };
			} catch (err) {
				return { error: (err as { code?: string }).code ?? String(err) };
			}
		}
		case 'claim':
			return { ids: claimBatch(ctx).map((row) => row.id) };
		case 'materialize':
			return { inserted: materializeSeriesById(ctx, rest[0]) };
		default:
			throw new Error(`Unknown operation ${op}`);
	}
}

const input = createInterface({ input: process.stdin });
input.once('line', () => {
	const result = perform();
	process.stdout.write(`${JSON.stringify(result)}\n`);
	sqlite.close();
	input.close();
});
process.stdout.write('ready\n');
