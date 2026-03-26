import { Request, Response, NextFunction } from "express";

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface AttemptRecord {
  count: number;
  resetAt: number;
}

// Tracks all per-limiter attempt Maps so the scheduler can clean them all.
const allAttemptMaps: Map<string, AttemptRecord>[] = [];

/**
 * Create a rate limiter middleware.
 *
 * Each call to createLimiter gets its own isolated attempt Map so that
 * separate limiters (e.g. loginLimiter and tokenLimiter) do not share
 * counters. Previously a single shared Map caused token requests to
 * consume login quota and vice versa.
 *
 * @param maxAttempts Maximum attempts allowed within the window
 * @param message Error message to return when limit is exceeded
 */
export const createLimiter = (maxAttempts: number, message: string) => {
  // Per-limiter isolated storage — not shared with any other limiter.
  const attempts = new Map<string, AttemptRecord>();
  allAttemptMaps.push(attempts);

  return (req: Request, res: Response, next: NextFunction) => {
    // Prefer X-Real-IP (set by nginx from $remote_addr, cannot be spoofed by client).
    // Fall back to the leftmost X-Forwarded-For entry for other proxy setups.
    // Do NOT fall back to req.socket.remoteAddress — behind a reverse proxy that
    // is always the Docker bridge gateway, never the real client.
    const xRealIp = req.headers["x-real-ip"];
    const xForwardedFor = req.headers["x-forwarded-for"];
    const forwarded = Array.isArray(xForwardedFor)
      ? xForwardedFor[0]
      : xForwardedFor?.split(",")[0]?.trim();
    const ip =
      (typeof xRealIp === "string" ? xRealIp : undefined) ??
      forwarded ??
      req.ip ??
      "unknown";
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
 * Clean up expired attempt records across all limiter Maps.
 * Called periodically to prevent memory buildup.
 */
export const cleanupExpiredAttempts = (): number => {
  const now = Date.now();
  let cleaned = 0;

  for (const attempts of allAttemptMaps) {
    for (const [ip, record] of attempts) {
      if (now >= record.resetAt) {
        attempts.delete(ip);
        cleaned++;
      }
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
