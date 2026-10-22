/**
 * IP-based probe rate limiter for the IMAP and SMTP servers.
 *
 * Unlike the HTTP rate limiter (Express middleware), this module exposes
 * plain functions that IMAP/SMTP session handlers can call directly.
 *
 * Two budgets are kept, because the two probes answer different questions and
 * must not lock each other out: a failed credential is charged to the auth
 * budget, and a recipient that resolves to no mailbox is charged to the
 * recipient budget. Both are per-IP and share the window and the delay.
 *
 * Policy (auth budget):
 *  - After the budget's maximum failed attempts from the same IP in WINDOW_MS,
 *    the caller should refuse without doing the lookup.
 *  - A 500ms delay is added after each failure to slow brute-force attempts.
 *  - Failures are tracked at two granularities: a per-IP aggregate bucket
 *    that every failure from the IP feeds, plus one bucket per attempted
 *    account under that IP. The gate refuses when either trips, and a
 *    successful auth clears only the authenticating account's own bucket —
 *    the aggregate keeps accumulating, so one account's success can no
 *    longer forgive another account's failures from the same IP.
 */

const MAX_FAILURES = 10;
const MAX_RECIPIENT_PROBES = 10;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const FAILURE_DELAY_MS = 500;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface AttemptRecord {
  count: number;
  resetAt: number;
}

const authAttempts = new Map<string, AttemptRecord>();
const authAccountAttempts = new Map<string, AttemptRecord>();
const recipientProbes = new Map<string, AttemptRecord>();

// `\u0000` separates the components; neither an IP nor a normalized account
// name can contain one, so a crafted account string cannot collide with a
// different (ip, account) pair.
const accountKey = (ip: string, account: string): string => `${ip}\u0000${account}`;

/**
 * The account identity an auth attempt is bucketed under: the attempted
 * username, normalized so trivial case/whitespace rotation of the identity
 * does not buy a fresh bucket. Returns undefined when the username is empty;
 * the per-IP aggregate still applies in that case.
 */
export const normalizeAuthAccount = (
  username: string | undefined
): string | undefined => {
  if (username === undefined) return undefined;
  const account = username.trim().toLowerCase();
  return account === "" ? undefined : account;
};

const getRecord = (
  store: Map<string, AttemptRecord>,
  ip: string
): AttemptRecord => {
  const now = Date.now();
  const existing = store.get(ip);
  if (existing && now < existing.resetAt) return existing;
  const record: AttemptRecord = { count: 0, resetAt: now + WINDOW_MS };
  store.set(ip, record);
  return record;
};

const record = async (
  store: Map<string, AttemptRecord>,
  ip: string,
  max: number
): Promise<boolean> => {
  const attempt = getRecord(store, ip);
  attempt.count++;
  // Delay to slow brute-force attempts
  await new Promise<void>((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
  return attempt.count >= max;
};

/**
 * Check whether the given IP is currently rate-limited.
 * Returns true if the IP's aggregate bucket has exceeded the failure
 * threshold, or — when an account is given — that account's own bucket has.
 */
export const isAuthRateLimited = (ip: string, account?: string): boolean => {
  if (getRecord(authAttempts, ip).count >= MAX_FAILURES) return true;
  return (
    account !== undefined &&
    getRecord(authAccountAttempts, accountKey(ip, account)).count >=
      MAX_FAILURES
  );
};

/**
 * Record a failed auth attempt for the given IP, and — when an account is
 * given — against that account's own bucket under the IP.
 * Adds a delay to slow brute-force attacks.
 * Returns true if the IP is now rate-limited (hit the threshold this call).
 */
export const recordAuthFailure = async (
  ip: string,
  account?: string
): Promise<boolean> => {
  const aggregateLimited = await record(authAttempts, ip, MAX_FAILURES);
  if (account === undefined) return aggregateLimited;
  // The account bucket rides the same failure event, so there is only one
  // delay per failure.
  const attempt = getRecord(authAccountAttempts, accountKey(ip, account));
  attempt.count++;
  return aggregateLimited || attempt.count >= MAX_FAILURES;
};

/**
 * Reset the failure counter on successful auth. With an account, only that
 * account's own bucket is cleared and the per-IP aggregate keeps
 * accumulating; without one, the whole IP bucket (aggregate plus every
 * account bucket under it) is cleared, preserving the
 * pre-account-granularity contract.
 */
export const resetAuthFailures = (ip: string, account?: string): void => {
  if (account === undefined) {
    authAttempts.delete(ip);
    const prefix = `${ip}\u0000`;
    for (const key of authAccountAttempts.keys()) {
      if (key.startsWith(prefix)) {
        authAccountAttempts.delete(key);
      }
    }
    return;
  }
  authAccountAttempts.delete(accountKey(ip, account));
};

/**
 * Check whether the given IP has spent its recipient-probe budget.
 *
 * Read before the mailbox lookup, not after: the budget exists to bound the
 * connection-pool draw an unauthenticated peer can cause, and a check that
 * runs after the query has already paid for it.
 */
export const isRecipientProbeRateLimited = (ip: string): boolean => {
  return getRecord(recipientProbes, ip).count >= MAX_RECIPIENT_PROBES;
};

/**
 * Record a recipient that resolved to no mailbox for the given IP.
 *
 * Charged on the refusal rather than on every recipient so that a legitimate
 * multi-recipient transaction is never throttled, and priced identically to a
 * failed credential so that answering "does this mailbox exist" costs the same
 * from either surface.
 *
 * Returns true if the IP is now rate-limited (hit the threshold this call).
 */
export const recordRecipientProbe = (ip: string): Promise<boolean> => {
  return record(recipientProbes, ip, MAX_RECIPIENT_PROBES);
};

/**
 * Reset the recipient-probe counter for the given IP.
 */
export const resetRecipientProbes = (ip: string): void => {
  recipientProbes.delete(ip);
};

/**
 * Clean up expired attempt records across both budgets.
 */
export const cleanupExpiredRateLimitRecords = (): number => {
  const now = Date.now();
  let cleaned = 0;
  for (const store of [authAttempts, authAccountAttempts, recipientProbes]) {
    for (const [ip, attempt] of store) {
      if (now >= attempt.resetAt) {
        store.delete(ip);
        cleaned++;
      }
    }
  }
  return cleaned;
};

// Schedule periodic cleanup
setInterval(() => {
  cleanupExpiredRateLimitRecords();
}, CLEANUP_INTERVAL_MS);
