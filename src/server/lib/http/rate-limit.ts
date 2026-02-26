import { Request, Response, NextFunction } from "express";

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface AttemptRecord {
  count: number;
  resetAt: number;
}

// Shared attempt storage for all limiters
const attempts = new Map<string, AttemptRecord>();

/**
 * Create a rate limiter middleware.
 *
 * @param maxAttempts Maximum attempts allowed within the window
 * @param message Error message to return when limit is exceeded
 */
export const createLimiter = (maxAttempts: number, message: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const record = attempts.get(ip);

    if (record && now < record.resetAt) {
      if (record.count >= maxAttempts) {
        res.status(429).json({ status: "failed", message });
        return;
      }
      record.count++;
    } else {
      attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    }

    next();
  };
};

/**
 * Clean up expired attempt records.
 * Called periodically to prevent memory buildup.
 */
export const cleanupExpiredAttempts = (): number => {
  const now = Date.now();
  let cleaned = 0;

  for (const [ip, record] of attempts) {
    if (now >= record.resetAt) {
      attempts.delete(ip);
      cleaned++;
    }
  }

  return cleaned;
};

// Schedule periodic cleanup
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export const startCleanupScheduler = () => {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(() => {
    const cleaned = cleanupExpiredAttempts();
    if (cleaned > 0) {
      console.log(`[Rate Limit] Cleaned up ${cleaned} expired attempt records`);
    }
  }, CLEANUP_INTERVAL_MS);

  // Run initial cleanup
  cleanupExpiredAttempts();
};

export const stopCleanupScheduler = () => {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
};

// Pre-configured limiters for auth endpoints
export const loginLimiter = createLimiter(
  5,
  "Too many login attempts, try again later"
);

export const tokenLimiter = createLimiter(
  3,
  "Too many token requests, try again later"
);
