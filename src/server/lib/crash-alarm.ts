import { sendAlarm } from "./alarm";

/**
 * Max time we wait for a crash alarm to deliver before the process exits
 * anyway. Guarantees a prompt exit even if the Discord webhook is slow or
 * unreachable — otherwise a stuck fetch inside `sendAlarm` would replace
 * one zombie-hang with another and defeat the whole point of exiting.
 */
export const CRASH_ALARM_TIMEOUT_MS = 5_000;

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
export const deliverCrashAlarm = async (
  title: string,
  error: unknown,
): Promise<void> => {
  await Promise.race([
    sendAlarm(title, formatCrashDetail(error)).catch(() => undefined),
    new Promise<void>((resolve) =>
      setTimeout(resolve, CRASH_ALARM_TIMEOUT_MS),
    ),
  ]);
};

/** `deliverCrashAlarm`, then `process.exit(1)` so docker's restart policy takes over. */
export const alarmThenExit = async (
  title: string,
  error: unknown,
): Promise<never> => {
  await deliverCrashAlarm(title, error);
  process.exit(1);
};
