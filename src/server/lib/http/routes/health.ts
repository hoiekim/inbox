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

  // SMTP (port 25)
  const smtpOk = await checkPort(25);
  checks.smtp = smtpOk ? "ok" : "unhealthy";
  if (!smtpOk) allHealthy = false;

  // IMAP (port 143)
  const imapOk = await checkPort(143);
  checks.imap = imapOk ? "ok" : "unhealthy";
  if (!imapOk) allHealthy = false;

  const statusCode = allHealthy ? 200 : 503;
  res.status(statusCode).json({
    status: allHealthy ? "success" : "error",
    body: { healthy: allHealthy, checks, timestamp: Date.now() },
  });
});

export default healthRouter;
