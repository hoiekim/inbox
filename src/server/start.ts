import "./config";

import {
  initializePostgres,
  initializeAdminUser,
  cleanSubscriptions,
  initializeImap,
  initializeSmtp,
  initializeHttp,
} from "server";
import { pool } from "server";

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
