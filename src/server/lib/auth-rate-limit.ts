/**
 * IP-based authentication rate limiter for IMAP and SMTP servers.
 *
 * Unlike the HTTP rate limiter (Express middleware), this module exposes
 * plain functions that IMAP/SMTP session handlers can call directly.
 *
 * Policy:
 *  - After MAX_FAILURES failed auth attempts from the same IP in WINDOW_MS,
 *    the caller should terminate the connection.
 *  - A 500ms delay is added after each failure to slow brute-force attempts.
 *  - A successful auth resets the counter for that IP.
 */

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const FAILURE_DELAY_MS = 500;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface AttemptRecord {
  count: number;
  resetAt: number;
}

const attempts = new Map<string, AttemptRecord>();

const getRecord = (ip: string): AttemptRecord => {
  const now = Date.now();
  const existing = attempts.get(ip);
  if (existing && now < existing.resetAt) return existing;
  const record: AttemptRecord = { count: 0, resetAt: now + WINDOW_MS };
  attempts.set(ip, record);
  return record;
};

/**
 * Check whether the given IP is currently rate-limited.
 * Returns true if the IP has exceeded the failure threshold.
 */
export const isAuthRateLimited = (ip: string): boolean => {
  const record = getRecord(ip);
  return record.count >= MAX_FAILURES;
};

/**
 * Record a failed auth attempt for the given IP.
 * Adds a delay to slow brute-force attacks.
 * Returns true if the IP is now rate-limited (hit the threshold this call).
 */
export const recordAuthFailure = async (ip: string): Promise<boolean> => {
  const record = getRecord(ip);
  record.count++;
  // Delay to slow brute-force attempts
  await new Promise<void>((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
  return record.count >= MAX_FAILURES;
};

/**
 * Reset the failure counter for the given IP on successful auth.
 */
export const resetAuthFailures = (ip: string): void => {
  attempts.delete(ip);
};

/**
 * Clean up expired attempt records.
 */
export const cleanupExpiredAuthAttempts = (): number => {
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
setInterval(() => {
  cleanupExpiredAuthAttempts();
}, CLEANUP_INTERVAL_MS);
