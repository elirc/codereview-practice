import type { Logger } from "./logger";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Development mailer: writes each message to the structured log instead of delivering it. */
export class ConsoleMailer implements Mailer {
  constructor(
    private readonly log: Logger,
    private readonly from: string,
  ) {}

  async send(message: MailMessage): Promise<void> {
    this.log.info({ mail: { from: this.from, ...message } }, "email sent via console mailer");
  }
}

/** Test mailer: records messages and can be told to fail the next sends. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  private readonly failures: Error[] = [];

  failNext(times = 1, error = new Error("mail provider unavailable")): void {
    for (let i = 0; i < times; i += 1) this.failures.push(error);
  }

  async send(message: MailMessage): Promise<void> {
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.sent.push(message);
  }
}

export function createMailer(kind: "console" | "memory", log: Logger, from: string): Mailer {
  return kind === "memory" ? new MemoryMailer() : new ConsoleMailer(log, from);
}
