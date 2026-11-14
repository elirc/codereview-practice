import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import pino from "pino";
import { getSchedulerEnv } from "../src/env";

const env = getSchedulerEnv();
const logger = pino({ level: env.LOG_LEVEL, base: { service: "cms-scheduler" } });
const endpoint = new URL("/api/internal/cron/publish", env.APP_URL);
const REQUEST_TIMEOUT_MS = 120_000;

const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "scheduler stopping");
    stop.abort();
  });
}

async function tick(attempt: number): Promise<void> {
  const requestId = `scheduler-${randomUUID()}`;
  const log = logger.child({ jobId: requestId, attempt });
  log.info("tick started");
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${env.CRON_SECRET}`, "x-request-id": requestId },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      log.warn({ status: response.status, body }, "tick failed");
      return;
    }
    const { published } = (await response.json()) as { published: string[] };
    log.info({ published: published.length }, "tick finished");
  } catch (err) {
    log.error({ err }, "tick request failed");
  }
}

async function main(): Promise<void> {
  logger.info(
    { endpoint: endpoint.href, intervalMs: env.SCHEDULER_INTERVAL_MS },
    "scheduler started",
  );
  let attempt = 0;
  while (!stop.signal.aborted) {
    attempt += 1;
    await tick(attempt);
    try {
      await sleep(env.SCHEDULER_INTERVAL_MS, undefined, { signal: stop.signal });
    } catch {
      break;
    }
  }
}

void main();
