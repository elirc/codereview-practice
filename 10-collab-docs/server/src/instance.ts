import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config/config.js';
import { DocStore } from './collab/docStore.js';
import { RoomRegistry } from './collab/registry.js';
import { createDb, type Db } from './db/db.js';
import { buildApp } from './http/app.js';
import { systemClock, type Clock } from './lib/clock.js';
import { createLogger, type Logger } from './lib/logger.js';
import { cryptoRandom, type RandomSource } from './lib/random.js';
import type { ServiceContext } from './services/context.js';
import { silentNotifier } from './services/notifier.js';
import { CollabServer } from './ws/server.js';

export interface InstanceOptions {
  config: Config;
  clock?: Clock;
  random?: RandomSource;
  logger?: Logger;
}

export interface Instance {
  config: Config;
  app: FastifyInstance;
  db: Db;
  store: DocStore;
  registry: RoomRegistry;
  collab: CollabServer;
  ctx: ServiceContext;
  /** Starts listening and returns the bound port. */
  listen(port?: number, host?: string): Promise<number>;
  /** Shuts the instance down in order and releases its connections. */
  close(): Promise<void>;
}

/** Wires one server instance: HTTP API, WebSocket collaboration and shared state. */
export function createInstance(options: InstanceOptions): Instance {
  const { config } = options;
  const clock = options.clock ?? systemClock;
  const random = options.random ?? cryptoRandom;
  const logger = options.logger ?? createLogger(config.LOG_LEVEL, { process: 'server' });

  const db = createDb(config.DATABASE_URL);
  const store = new DocStore(db, clock, config.MAX_DOC_BYTES);
  const registry = new RoomRegistry({ store, logger, roomIdleMs: config.ROOM_IDLE_MS });
  const ctx: ServiceContext = { db, clock, random, config, notifier: silentNotifier };
  const app = buildApp({ ctx, logger });
  const collab = new CollabServer({ config, db, clock, random, logger, registry });
  collab.attach(app.server);
  let closing: Promise<void> | null = null;

  return {
    config,
    app,
    db,
    store,
    registry,
    collab,
    ctx,
    async listen(port = config.PORT, host = config.HOST) {
      await app.listen({ port, host });
      collab.startLoops();
      return (app.server.address() as AddressInfo).port;
    },
    close() {
      closing ??= (async () => {
        collab.stopAccepting();
        const httpClosed = app.close();
        await collab.shutdown();
        await httpClosed;
        await db.destroy();
      })();
      return closing;
    },
  };
}
