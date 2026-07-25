import { Router } from "express";
import { sendAlarm } from "../../alarm";
import { createLimiter, getClientIp } from "../rate-limit";

const clientErrorRouter = Router();

// Per-IP cap: frontend beacons only fire on actual JS errors, so a tight cap
// is plenty for legitimate use. Without this, an unauthenticated attacker can
// burn the alarm cooldown bucket indefinitely (issue #517).
const clientErrorLimiter = createLimiter(
  5,
  "Too many client error reports, try again later",
);

type ClientErrorBody = {
  message?: string;
  stack?: string;
  url?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
};

/**
 * POST /client-error
 *
 * Accepts frontend error reports sent via navigator.sendBeacon.
 * Forwards to Discord alarm. No auth required (beacon fires after page unload),
 * but IP-rate-limited to prevent alarm-channel abuse.
 */
clientErrorRouter.post("/", clientErrorLimiter.middleware, async (req, res) => {
  // Every accepted report consumes one slot in the per-IP quota. Unlike the
  // auth limiters (which only count failures), there is no success/failure
  // distinction here — the cap exists to bound report *volume*, so record on
  // each request that clears the read-only middleware check.
  clientErrorLimiter.recordFailure(getClientIp(req));

  const body = req.body as ClientErrorBody;

  const message = typeof body.message === "string" ? body.message : "(no message)";
  const stack = typeof body.stack === "string" ? body.stack : "";
  const url = typeof body.url === "string" ? body.url : "";
  const filename = typeof body.filename === "string" ? body.filename : "";
  const lineno = typeof body.lineno === "number" ? body.lineno : undefined;
  const colno = typeof body.colno === "number" ? body.colno : undefined;

  // When the message is the opaque "Script error." (cross-origin throw), the
  // source location is the only way to tell an extension/CDN chunk from our
  // own code — surface it so the alarm is actionable.
  // Only append the column once a line is known — a column-without-line report
  // would otherwise render `filename:7` and misread the column as a line number.
  const location = filename
    ? `${filename}${
        lineno !== undefined
          ? `:${lineno}${colno !== undefined ? `:${colno}` : ""}`
          : ""
      }`
    : "";

  console.error("Client error reported:", { url, message, location });

  const detail = [
    url ? `**URL:** ${url}` : null,
    `**Message:** ${message}`,
    location ? `**Source:** ${location}` : null,
    stack ? `\`\`\`\n${stack.slice(0, 1000)}\n\`\`\`` : null,
  ]
    .filter(Boolean)
    .join("\n");

  // Use a dedicated cooldown bucket so client-error volume cannot suppress
  // unrelated server-side alarms (route 5xx, unhandledRejection, IMAP/SMTP).
  await sendAlarm("Client JS Error", detail, "client-error");

  res.json({ status: "success" });
});

export default clientErrorRouter;
