import { Redis } from 'ioredis';
import type { Logger } from '../lib/logger.js';
import type { BusMessage } from './busMessages.js';

export type BusHandler = (message: unknown) => void;

/** Redis pub/sub with one publishing and one subscribing connection per instance. */
export class Bus {
  readonly instanceId: string;
  readonly publisher: Redis;
  readonly subscriber: Redis;
  private readonly log: Logger;
  private readonly handlers = new Map<string, Set<BusHandler>>();
  private readonly readyListeners = new Set<() => void>();
  private connected = false;

  constructor(redisUrl: string, instanceId: string, logger: Logger) {
    this.instanceId = instanceId;
    this.log = logger.child({ component: 'bus' });
    this.publisher = new Redis(redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    this.subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });

    this.publisher.on('error', (error: Error) => this.log.warn({ err: error }, 'publisher error'));
    this.subscriber.on('error', (error: Error) => this.log.warn({ err: error }, 'subscriber error'));
    this.subscriber.on('close', () => {
      this.connected = false;
    });
    this.subscriber.on('ready', () => {
      this.connected = true;
      this.log.info('subscriber ready');
      for (const listener of this.readyListeners) listener();
    });
    this.subscriber.on('message', (channel: string, raw: string) => this.dispatch(channel, raw));
  }

  /** Registers a listener called every time the subscriber connection becomes ready. */
  onReady(listener: () => void): void {
    this.readyListeners.add(listener);
  }

  /**
   * Adds a handler for a channel. Resolves once Redis confirms the
   * subscription, or immediately while the subscriber is disconnected.
   */
  async subscribe(channel: string, handler: BusHandler): Promise<void> {
    let set = this.handlers.get(channel);
    if (set) {
      set.add(handler);
      return;
    }
    set = new Set([handler]);
    this.handlers.set(channel, set);
    const subscribed = this.subscriber.subscribe(channel);
    if (this.connected) {
      await subscribed;
    } else {
      subscribed.catch((error: unknown) => this.log.warn({ err: error, channel }, 'subscribe failed'));
    }
  }

  /** Removes a handler and unsubscribes when the channel has no handlers left. */
  async unsubscribe(channel: string, handler: BusHandler): Promise<void> {
    const set = this.handlers.get(channel);
    if (!set) return;
    set.delete(handler);
    if (set.size > 0) return;
    this.handlers.delete(channel);
    try {
      await this.subscriber.unsubscribe(channel);
    } catch (error) {
      this.log.warn({ err: error, channel }, 'unsubscribe failed');
    }
  }

  /** Publishes a message; rejects when Redis is unavailable. */
  async publish(channel: string, message: BusMessage): Promise<void> {
    await this.publisher.publish(channel, JSON.stringify(message));
  }

  /** Closes both connections. */
  async close(): Promise<void> {
    this.readyListeners.clear();
    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
  }

  private dispatch(channel: string, raw: string): void {
    const set = this.handlers.get(channel);
    if (!set) return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.log.warn({ channel }, 'ignoring non-JSON bus message');
      return;
    }
    for (const handler of set) {
      try {
        handler(message);
      } catch (error) {
        this.log.error({ err: error, channel }, 'bus handler failed');
      }
    }
  }
}
