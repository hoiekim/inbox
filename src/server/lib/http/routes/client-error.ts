import { Router } from "express";
import { sendAlarm } from "../../alarm";
import { logger } from "../../../logger";

const clientErrorRouter = Router();

type ClientErrorBody = {
  message?: string;
  stack?: string;
  url?: string;
};

/**
 * POST /client-error
 *
 * Accepts frontend error reports sent via navigator.sendBeacon.
 * Forwards to Discord alarm. No auth required (beacon fires after page unload).
 */
clientErrorRouter.post("/", async (req, res) => {
  const body = req.body as ClientErrorBody;

  const message = typeof body.message === "string" ? body.message : "(no message)";
  const stack = typeof body.stack === "string" ? body.stack : "";
  const url = typeof body.url === "string" ? body.url : "";

  logger.error("Client error reported", { url, message });

  const detail = [
    url ? `**URL:** ${url}` : null,
    `**Message:** ${message}`,
    stack ? `\`\`\`\n${stack.slice(0, 1000)}\n\`\`\`` : null,
  ]
    .filter(Boolean)
    .join("\n");

  await sendAlarm("Client JS Error", detail);

  res.json({ status: "success" });
});

export default clientErrorRouter;
