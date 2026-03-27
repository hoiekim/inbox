import { Router } from "express";
import { createConnection } from "net";
import { pool } from "../../postgres/client";

const healthRouter = Router();

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

  // SMTP (port 25 — plain)
  const smtpOk = await checkPort(25);
  checks["smtp:25"] = smtpOk ? "ok" : "unhealthy";
  if (!smtpOk) allHealthy = false;

  // SMTP TLS (port 465 — implicit TLS)
  const smtpTlsOk = await checkPort(465);
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

  // IMAP TLS (port 993 — implicit TLS)
  const imapTlsOk = await checkPort(993);
  checks["imap:993"] = imapTlsOk ? "ok" : "unhealthy";
  if (!imapTlsOk) allHealthy = false;

  const statusCode = allHealthy ? 200 : 503;
  res.status(statusCode).json({
    status: allHealthy ? "success" : "error",
    body: { healthy: allHealthy, checks, timestamp: Date.now() },
  });
});

export default healthRouter;
