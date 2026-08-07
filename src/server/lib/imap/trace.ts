import { logger } from "server";

const TRACE_ON = process.env.IMAP_TRACE === "1";
const LINE_CAP = 200;

const clip = (s: string): string =>
  s.length <= LINE_CAP ? s : `${s.slice(0, LINE_CAP)}…[+${s.length - LINE_CAP}]`;

export const imapTrace = (
  direction: "in" | "out",
  sessionId: string,
  data: string
): void => {
  if (!TRACE_ON) return;
  for (const raw of data.split("\r\n")) {
    if (!raw) continue;
    logger.info(`IMAP wire ${direction}`, {
      component: "imap.trace",
      sessionId,
      line: clip(raw),
    });
  }
};

export const isImapTraceOn = (): boolean => TRACE_ON;
