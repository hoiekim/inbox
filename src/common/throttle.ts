/**
 * General throttling for operations
 */

export class Throttle {
  private operationQueue = new Map<string, number>();
  private readonly maxConcurrent: number;
  private readonly windowMs: number;

  constructor(maxConcurrent = 5, windowMs = 1000) {
    this.maxConcurrent = maxConcurrent;
    this.windowMs = windowMs;
  }

  async throttle<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const lastOperation = this.operationQueue.get(key) || 0;

    // Rate limit: max operations per window per key
    if (now - lastOperation < this.windowMs / this.maxConcurrent) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.operationQueue.set(key, now);

    // Clean old entries
    if (this.operationQueue.size > 100) {
      this.operationQueue.forEach((time, id) => {
        if (now - time > this.windowMs * 10) {
          this.operationQueue.delete(id);
        }
      });
    }

    return await operation();
  }
}
