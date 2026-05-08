import { Router } from "express";
import { createConnection } from "net";
import { connect as tlsConnect } from "tls";
import { existsSync } from "fs";
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
        // socket.end() sends TLS close_notify — a clean shutdown.
        // socket.destroy() aborts the connection, which makes smtp-server
        // fire an error event ("Socket closed while initiating TLS").
        socket.end(() => resolve(true));
      }
    );
    socket.setTimeout(3000);
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });

// Mirrors the SSL gate used in smtp.ts and imap/index.ts. When SSL is not
// configured, those servers don't start TLS listeners — so health must not
// probe-and-fail them; report `not_configured` instead.
const isSslConfigured = (): boolean => {
  const { SSL_CERTIFICATE, SSL_CERTIFICATE_KEY } = process.env;
  if (!SSL_CERTIFICATE || !SSL_CERTIFICATE_KEY) return false;
  return existsSync(SSL_CERTIFICATE) && existsSync(SSL_CERTIFICATE_KEY);
};

type CheckStatus = "ok" | "unhealthy" | "not_configured";

healthRouter.get("/", async (_req, res) => {
  const checks: Record<string, CheckStatus> = {};
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

  // SMTP plain (use SMTP_PORT env var; defaults to 25). Always required.
  const smtpPort = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 25;
  const smtpOk = await checkPort(smtpPort);
  checks[`smtp:${smtpPort}`] = smtpOk ? "ok" : "unhealthy";
  if (!smtpOk) allHealthy = false;

  // IMAP plain (use IMAP_PORT env var; defaults to 143). Always required.
  const imapPort = process.env.IMAP_PORT ? parseInt(process.env.IMAP_PORT, 10) : 143;
  const imapOk = await checkPort(imapPort);
  checks[`imap:${imapPort}`] = imapOk ? "ok" : "unhealthy";
  if (!imapOk) allHealthy = false;

  // TLS-dependent ports (smtp:465, smtp:587, imap:993) only run when SSL is
  // configured (see smtp.ts and imap/index.ts). If SSL is absent, mark
  // `not_configured` and exclude from the rollup. With SSL configured, treat
  // them as required and let an actual TLS-port failure fail the rollup.
  const sslConfigured = isSslConfigured();

  if (sslConfigured) {
    const smtpTlsOk = await checkTlsPort(465);
    checks["smtp:465"] = smtpTlsOk ? "ok" : "unhealthy";
    if (!smtpTlsOk) allHealthy = false;

    const smtpStarttlsOk = await checkPort(587);
    checks["smtp:587"] = smtpStarttlsOk ? "ok" : "unhealthy";
    if (!smtpStarttlsOk) allHealthy = false;

    const imapTlsOk = await checkTlsPort(993);
    checks["imap:993"] = imapTlsOk ? "ok" : "unhealthy";
    if (!imapTlsOk) allHealthy = false;
  } else {
    checks["smtp:465"] = "not_configured";
    checks["smtp:587"] = "not_configured";
    checks["imap:993"] = "not_configured";
  }

  const statusCode = allHealthy ? 200 : 503;
  res.status(statusCode).json({
    status: allHealthy ? "success" : "error",
    body: { healthy: allHealthy, checks, timestamp: Date.now() },
  });
});

export default healthRouter;
