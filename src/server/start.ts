import "./config";

import {
  initializePostgres,
  bootMaintenance,
  initializeAdminUser,
  push,
  initializeImap,
  initializeSmtp,
  initializeHttp,
  idleManager,
} from "server";
import { pool } from "server";
import { sendAlarm } from "./lib/alarm";
import {
  boundCrashStep,
  claimCrashSequence,
  deliverCrashAlarm,
  formatCrashDetail,
  POOL_SHUTDOWN_TIMEOUT_MS,
} from "./lib/crash-alarm";
import { handleStartupFailure } from "./lib/startup-failure";

// Process-level error handlers (centralised here alongside SIGTERM/SIGINT).
// Note: These fire before IMAP/SMTP servers are shut down.
//
// `unhandledRejection` does not exit, so its alarm stays fire-and-forget —
// the process outlives the POST. `uncaughtException` exits, so it must await
// the delivery under the shared bound first (see crash-alarm.ts).
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
  sendAlarm(
    "Unhandled Promise Rejection",
    formatCrashDetail(reason),
  ).catch(() => undefined);
});

process.on("uncaughtException", async (error) => {
  console.error("Uncaught exception:", error);
  if (!claimCrashSequence()) return;
  await deliverCrashAlarm("Uncaught Exception", error);
  await boundCrashStep(pool.end(), POOL_SHUTDOWN_TIMEOUT_MS);
  process.exit(1);
});

const start = async () => {
  await initializePostgres();
  await initializeAdminUser();
  push.initPush();
  const httpServer = await initializeHttp();
  const smtpServers = await initializeSmtp();
  const imapServers = await initializeImap();
  push.cleanSubscriptions();

  // Index builds and the search-vector reindex scale with the size of `mails`,
  // so they run after the listeners are bound rather than in front of them —
  // the builds are `CONCURRENTLY` precisely so the table stays writable
  // throughout, and awaiting them would push first bind past the container
  // healthcheck's start period on a large table. `bootMaintenance` never
  // rejects; it alarms on its own if the work doesn't complete.
  const maintenanceAbort = new AbortController();
  const maintenance = bootMaintenance(maintenanceAbort.signal);

  const shutdown = async (signal: string) => {
    console.info(`${signal} received — shutting down gracefully`);

    // First, and synchronously: cancelling an in-flight index build is a
    // round-trip on another connection, so it overlaps the server closes below
    // instead of serializing behind them. Compose's default grace period is
    // 10s and `await maintenance` has to fit inside it.
    maintenanceAbort.abort();

    // Stop accepting new HTTP connections; finish in-flight requests
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    console.info("HTTP server closed");

    // Notify IDLE clients and stop heartbeat timer before closing sockets
    idleManager.shutdown();
    console.info("IDLE sessions cleaned up");

    // Close IMAP servers (send BYE to active sessions handled by socket destroy)
    await Promise.all(
      imapServers.map(
        (s) => new Promise<void>((resolve) => s.close(() => resolve()))
      )
    );
    console.info("IMAP servers closed");

    // Close SMTP servers (finish active transactions)
    await Promise.all(
      smtpServers.map(
        (s) => new Promise<void>((resolve) => s.close(() => resolve()))
      )
    );
    console.info("SMTP servers closed");

    // The maintenance client is checked out for the duration of the phase, and
    // `pool.end()` waits for every client to be released — so the phase has to
    // have finished unwinding (from the abort above) before the pool closes.
    await maintenance;
    console.info("Boot maintenance stopped");

    // Close the database connection pool
    await pool.end();
    console.info("Database pool closed");

    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

start().catch(handleStartupFailure);
