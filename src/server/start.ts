import "./config";

import {
  initializePostgres,
  initializeAdminUser,
  cleanSubscriptions,
  initializeImap,
  initializeSmtp,
  initializeHttp,
  idleManager,
} from "server";
import { pool } from "server";
import { sendAlarm } from "./lib/alarm";

// Process-level error handlers (centralised here alongside SIGTERM/SIGINT)
// Note: These fire before IMAP/SMTP servers are shut down. The alarm call is
// fire-and-forget (.catch(() => undefined)) to avoid interfering with the
// crash/exit sequence.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? (reason.stack ?? "") : "";
  sendAlarm(
    "Unhandled Promise Rejection",
    `**Message:** ${message}\n\`\`\`\n${stack.slice(0, 1000)}\n\`\`\``,
  ).catch(() => undefined);
});

process.on("uncaughtException", async (error) => {
  console.error("Uncaught exception:", error);
  sendAlarm(
    "Uncaught Exception",
    `**Message:** ${error.message}\n\`\`\`\n${(error.stack ?? "").slice(0, 1000)}\n\`\`\``,
  ).catch(() => undefined);
  try {
    await pool.end();
  } catch (e) {
    // ignore pool shutdown errors during crash
  }
  process.exit(1);
});

const start = async () => {
  await initializePostgres();
  await initializeAdminUser();
  const httpServer = await initializeHttp();
  const smtpServers = await initializeSmtp();
  const imapServers = await initializeImap();
  cleanSubscriptions();

  const shutdown = async (signal: string) => {
    console.info(`${signal} received — shutting down gracefully`);

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

    // Close the database connection pool
    await pool.end();
    console.info("Database pool closed");

    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

start();
