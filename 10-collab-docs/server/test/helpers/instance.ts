import { createDb } from '../../src/db/db.js';
import { createInstance, type Instance } from '../../src/instance.js';
import { createLogger } from '../../src/lib/logger.js';
import { FakeClock, resetDb, testConfig, TEST_DATABASE_URL } from './env.js';

export interface RunningInstance {
  instance: Instance;
  url: string;
  clock: FakeClock;
}

const running: RunningInstance[] = [];

/** Empties the test database. */
export async function freshDatabase(): Promise<void> {
  const db = createDb(TEST_DATABASE_URL, 1);
  try {
    await resetDb(db);
  } finally {
    await db.destroy();
  }
}

/** Starts an instance on an ephemeral port; instances share the clock passed in. */
export async function startInstance(
  options: { clock?: FakeClock; env?: Record<string, string> } = {},
): Promise<RunningInstance> {
  const clock = options.clock ?? new FakeClock();
  const config = testConfig({ WS_RATE_BURST: '100000', ...options.env });
  const instance = createInstance({ config, clock, logger: createLogger('silent') });
  const port = await instance.listen(0, '127.0.0.1');
  const started = { instance, url: `ws://127.0.0.1:${port}`, clock };
  running.push(started);
  return started;
}

/** Closes every instance started by `startInstance`. */
export async function stopInstances(): Promise<void> {
  const all = running.splice(0);
  await Promise.all(all.map((entry) => entry.instance.close()));
}

/** Resolves after the instance has seen `count` connections close. */
export function connectionsClosed(instance: Instance, count = 1): Promise<void> {
  return new Promise((resolve) => {
    let seen = 0;
    const onClosed = () => {
      seen += 1;
      if (seen < count) return;
      instance.collab.off('connection-closed', onClosed);
      resolve();
    };
    instance.collab.on('connection-closed', onClosed);
  });
}
