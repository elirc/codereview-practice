export const MAX_PAYLOAD_BYTES = 300_000;

/** Counts this instance's connections per (document, user) against a maximum. */
export class ConnectionCounter {
  private readonly max: number;
  private readonly counts = new Map<string, number>();

  constructor(max: number) {
    this.max = max;
  }

  private key(docId: string, userId: string): string {
    return `${docId}:${userId}`;
  }

  /** Reserves a slot; returns false when the user already has the maximum. */
  tryAcquire(docId: string, userId: string): boolean {
    const key = this.key(docId, userId);
    const count = this.counts.get(key) ?? 0;
    if (count >= this.max) return false;
    this.counts.set(key, count + 1);
    return true;
  }

  /** Gives back a slot taken with `tryAcquire`. */
  release(docId: string, userId: string): void {
    const key = this.key(docId, userId);
    const count = this.counts.get(key) ?? 0;
    if (count <= 1) this.counts.delete(key);
    else this.counts.set(key, count - 1);
  }

  count(docId: string, userId: string): number {
    return this.counts.get(this.key(docId, userId)) ?? 0;
  }
}
