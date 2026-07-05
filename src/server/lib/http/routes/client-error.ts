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
};

// Browser-emitted messages that are benign quirks, not real errors. The
// ResizeObserver "loop" messages fire when a ResizeObserver callback can't
// settle within a single animation frame during rapid layout changes — a
// Chrome diagnostic with no stack, no user-visible failure, and no server
// fault. They are still logged, but never forwarded to the alarm webhook so a
// benign frontend quirk can't page an operator (issue #629).
const BENIGN_CLIENT_MESSAGES = [
  "ResizeObserver loop completed with undelivered notifications",
  "ResizeObserver loop limit exceeded",
];

const isBenignClientMessage = (message: string): boolean =>
  BENIGN_CLIENT_MESSAGES.some((benign) => message.includes(benign));

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

  console.error("Client error reported:", { url, message });

  // A benign browser quirk (logged above) is not an alarm-worthy event. Skip
  // the webhook forward but still ack so the beacon doesn't retry.
  if (isBenignClientMessage(message)) {
    res.json({ status: "success" });
    return;
  }

  const detail = [
    url ? `**URL:** ${url}` : null,
    `**Message:** ${message}`,
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
