import { sendAlarm } from "./alarm";

/**
 * Max time we wait for the "Startup Failed" alarm to deliver before we
 * exit anyway. Guarantees the process exits promptly even if the Discord
 * webhook is slow or unreachable — otherwise a stuck fetch inside
 * sendAlarm would replace one zombie-hang with another and defeat the
 * whole point of the .catch handler in start.ts.
 */
export const STARTUP_ALARM_TIMEOUT_MS = 5_000;

/**
 * `start()`'s .catch handler. Log the fatal error, race the alarm delivery
 * against `STARTUP_ALARM_TIMEOUT_MS`, then `process.exit(1)` so docker's
 * restart policy (restart:always) can bring the container back up. Without
 * the exit, an early `initializePostgres()` rejection leaves the process
 * alive but pre-bind, and the container hangs "unhealthy" indefinitely.
 */
export const handleStartupFailure = async (error: unknown): Promise<never> => {
  console.error("Fatal error during startup:", error);
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  await Promise.race([
    sendAlarm(
      "Startup Failed",
      `**Message:** ${message}\n\`\`\`\n${stack.slice(0, 1000)}\n\`\`\``,
    ).catch(() => undefined),
    new Promise<void>((resolve) =>
      setTimeout(resolve, STARTUP_ALARM_TIMEOUT_MS),
    ),
  ]);
  process.exit(1);
};
