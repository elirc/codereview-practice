import type { Logger } from '../lib/logger.js';
import type { ControlEvent, DocEvent, Notifier } from '../services/notifier.js';
import type { Bus } from './bus.js';
import { CONTROL_CHANNEL, docChannel } from './busMessages.js';

/** Publishes service notifications on the Redis bus. */
export class BusNotifier implements Notifier {
  private readonly bus: Bus;
  private readonly log: Logger;

  constructor(bus: Bus, logger: Logger) {
    this.bus = bus;
    this.log = logger;
  }

  doc(docId: string, event: DocEvent): void {
    this.bus
      .publish(docChannel(docId), { ...event, instanceId: this.bus.instanceId })
      .catch((error: unknown) =>
        this.log.warn({ err: error, docId, kind: event.kind }, 'bus publish failed'),
      );
  }

  control(event: ControlEvent): void {
    this.bus
      .publish(CONTROL_CHANNEL, { ...event, instanceId: this.bus.instanceId })
      .catch((error: unknown) => this.log.warn({ err: error, kind: event.kind }, 'bus publish failed'));
  }
}
