/** A token bucket refilled continuously at a fixed rate, driven by caller-supplied time. */
export class TokenBucket {
  private readonly ratePerSecond: number;
  private readonly capacity: number;
  private tokens: number;
  private lastMs: number;

  constructor(ratePerSecond: number, capacity: number, nowMs: number) {
    this.ratePerSecond = ratePerSecond;
    this.capacity = capacity;
    this.tokens = capacity;
    this.lastMs = nowMs;
  }

  /** Takes one token at `nowMs`; returns false when the bucket is empty. */
  take(nowMs: number): boolean {
    if (nowMs > this.lastMs) {
      const refill = ((nowMs - this.lastMs) * this.ratePerSecond) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + refill);
      this.lastMs = nowMs;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
