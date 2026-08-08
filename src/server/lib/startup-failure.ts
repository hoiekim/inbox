import { alarmThenExit } from "./crash-alarm";

/**
 * `start()`'s .catch handler. Log the fatal error, deliver the "Startup
 * Failed" alarm under the shared crash-alarm bound, then `process.exit(1)`
 * so docker's restart policy (restart:always) can bring the container back
 * up. Without the exit, an early `initializePostgres()` rejection leaves the
 * process alive but pre-bind, and the container hangs "unhealthy"
 * indefinitely.
 */
export const handleStartupFailure = async (error: unknown): Promise<never> => {
  console.error("Fatal error during startup:", error);
  return alarmThenExit("Startup Failed", error);
};
