export class Throttler {
  private requests: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number = 10, windowMs: number = 1000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  private prune(now: number): void {
    this.requests = this.requests.filter((time) => now - time < this.windowMs);
  }

  /** Record one request against the window. */
  record(): void {
    const now = Date.now();
    this.prune(now);
    this.requests.push(now);
  }

  /**
   * Milliseconds until a new request fits inside the window (0 = fits now).
   * Does NOT record — callers that get 0 should call record() before
   * proceeding. This split lets consumers apply backpressure (wait for a
   * slot) rather than drop over-limit work.
   */
  msUntilFree(): number {
    const now = Date.now();
    this.prune(now);
    if (this.requests.length < this.maxRequests) return 0;
    const blocking = this.requests[this.requests.length - this.maxRequests];
    return Math.max(1, blocking + this.windowMs - now);
  }
}
