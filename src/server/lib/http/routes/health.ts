import { Router } from "express";
import { createConnection } from "net";
import { connect as tlsConnect } from "tls";
import { pool } from "../../postgres/client";

const healthRouter = Router();

/** TCP check — for plain or STARTTLS ports (just verify port is open). */
const checkPort = (port: number, host = "127.0.0.1"): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ port, host }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(1000);
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });

/**
 * TLS check — for implicit TLS ports (465, 993).
 * Completes the TLS handshake so the server doesn't log "Socket closed
 * while initiating TLS" from a bare TCP probe.
 */
const checkTlsPort = (port: number, host = "127.0.0.1"): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = tlsConnect(
      { port, host, rejectUnauthorized: false },
      () => {
        socket.destroy();
        resolve(true);
      }
    );
    socket.setTimeout(3000);
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });

// Use SMTP_PORT env var so health check matches the actual bound port.
// When running in Docker with port mapping (host:25 -> container:2525),
// SMTP_PORT=2525 is set via environment, and the container binds to 2525.
const smtpPort = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 25;

healthRouter.get("/", async (_req, res) => {
  const checks: Record<string, "ok" | "unhealthy"> = {};
  let allHealthy = true;

  // Database
  try {
    await pool.query("SELECT 1");
    checks.database = "ok";
  } catch {
    checks.database = "unhealthy";
    allHealthy = false;
  }

  // HTTP — always ok; this request proves the server is up
  checks.http = "ok";

  // SMTP (use SMTP_PORT env var; defaults to 25)
  const smtpOk = await checkPort(smtpPort);
  checks[`smtp:${smtpPort}`] = smtpOk ? "ok" : "unhealthy";
  if (!smtpOk) allHealthy = false;

  // SMTP TLS (port 465 — implicit TLS; use TLS handshake to avoid noise logs)
  const smtpTlsOk = await checkTlsPort(465);
  checks["smtp:465"] = smtpTlsOk ? "ok" : "unhealthy";
  if (!smtpTlsOk) allHealthy = false;

  // SMTP STARTTLS (port 587)
  const smtpStarttlsOk = await checkPort(587);
  checks["smtp:587"] = smtpStarttlsOk ? "ok" : "unhealthy";
  if (!smtpStarttlsOk) allHealthy = false;

  // IMAP (port 143 — plain/STARTTLS)
  const imapOk = await checkPort(143);
  checks["imap:143"] = imapOk ? "ok" : "unhealthy";
  if (!imapOk) allHealthy = false;

  // IMAP TLS (port 993 — implicit TLS; use TLS handshake to avoid noise logs)
  const imapTlsOk = await checkTlsPort(993);
  checks["imap:993"] = imapTlsOk ? "ok" : "unhealthy";
  if (!imapTlsOk) allHealthy = false;

  const statusCode = allHealthy ? 200 : 503;
  res.status(statusCode).json({
    status: allHealthy ? "success" : "error",
    body: { healthy: allHealthy, checks, timestamp: Date.now() },
  });
});

export default healthRouter;
