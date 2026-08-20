import { sendAlarm } from "./alarm";

/**
 * Max time we wait for a crash alarm to deliver before the process exits
 * anyway. Guarantees a prompt exit even if the Discord webhook is slow or
 * unreachable — otherwise a stuck fetch inside `sendAlarm` would replace
 * one zombie-hang with another and defeat the whole point of exiting.
 */
export const CRASH_ALARM_TIMEOUT_MS = 5_000;

/**
 * Max time we wait for the pg pool to drain before the process exits anyway.
 * `pool.end()` stays pending forever while a client is checked out against a
 * dead socket, which is precisely the shape a fatal DB fault arrives in.
 */
export const POOL_SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Await `step`, giving up after `timeoutMs` and swallowing its rejection.
 *
 * Every await on a path that ends in `process.exit` has to be bounded, or the
 * exit never happens and the container sits up-but-dead with docker's restart
 * policy never firing — the failure the exit exists to trigger.
 */
export const boundCrashStep = async (
  step: Promise<unknown>,
  timeoutMs: number,
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    step.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
};

/** Render a thrown value as the alarm body: message plus a bounded stack. */
export const formatCrashDetail = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  return `**Message:** ${message}\n\`\`\`\n${stack.slice(0, 1000)}\n\`\`\``;
};

/**
 * Send a crash alarm and wait for it, bounded by `CRASH_ALARM_TIMEOUT_MS`.
 *
 * Load-bearing on any path that exits: `sendAlarm` POSTs to a webhook, and a
 * fire-and-forget call followed by `process.exit` kills the process before
 * the request flushes, so the crash pages nobody. Never rejects — a failed
 * alarm must not divert the caller's crash sequence.
 */
export const deliverCrashAlarm = (
  title: string,
  error: unknown,
): Promise<void> =>
  boundCrashStep(
    sendAlarm(title, formatCrashDetail(error)),
    CRASH_ALARM_TIMEOUT_MS,
  );

let crashSequenceOwned = false;

/**
 * Claim the one crash sequence. Returns true to the first caller only; every
 * later caller gets false and must return without exiting.
 *
 * A crash cascade — a dead pool, a socket-teardown storm — throws from several
 * callbacks within milliseconds, and the `uncaughtException` handler is async
 * and therefore re-entrant. `sendAlarm` suppresses a repeat title under its
 * cooldown, so a second fault's delivery resolves in the same tick and its
 * `process.exit` kills the first fault's POST mid-flight, leaving nothing
 * delivered at all.
 */
export const claimCrashSequence = (): boolean => {
  if (crashSequenceOwned) return false;
  crashSequenceOwned = true;
  return true;
};

/** Release the claim (for testing). */
export const resetCrashSequence = (): void => {
  crashSequenceOwned = false;
};

/**
 * `deliverCrashAlarm`, then `process.exit(1)` so docker's restart policy takes
 * over. If another fault already owns the crash sequence, hand off to it rather
 * than exiting: that sequence is bounded and will exit on its own, whereas
 * exiting here kills its in-flight POST.
 */
export const alarmThenExit = async (
  title: string,
  error: unknown,
): Promise<never> => {
  if (!claimCrashSequence()) return new Promise<never>(() => undefined);
  await deliverCrashAlarm(title, error);
  process.exit(1);
};
