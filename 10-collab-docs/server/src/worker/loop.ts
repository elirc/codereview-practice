import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';

export interface LoopOptions {
  name: string;
  intervalMs: number;
  clock: Clock;
  logger: Logger;
  /** One pass of the loop; returns how many items it processed. */
  run: (now: Date) => Promise<number>;
}

export interface LoopHandle {
  /** Stops scheduling new passes and waits for the current one. */
  stop(): Promise<void>;
}

/** Runs a pass every `intervalMs`, never overlapping with itself. */
export function startLoop(options: LoopOptions): LoopHandle {
  const log = options.logger.child({ loop: options.name });
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<void> = Promise.resolve();
  let runNumber = 0;

  const pass = async () => {
    runNumber += 1;
    const run = runNumber;
    const startedAt = Date.now();
    log.info({ run }, 'loop run started');
    try {
      const processed = await options.run(options.clock.now());
      log.info({ run, processed, durationMs: Date.now() - startedAt }, 'loop run finished');
    } catch (error) {
      log.error({ err: error, run }, 'loop run failed');
    }
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      current = pass().finally(schedule);
    }, options.intervalMs);
  };

  schedule();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
    },
  };
}
