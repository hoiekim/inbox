import { logger } from "server";

const TRACE_ON = process.env.IMAP_TRACE === "1";
const LINE_CAP = 512;

const INBOUND_COMMAND = /^[A-Za-z0-9]+\s+[A-Z]+\b/;

// LOGIN carries the plaintext password as the last quoted arg; AUTHENTICATE
// carries the SASL initial response (RFC 4959) — base64-decoded, PLAIN yields
// `\0user\0password`. Both must be scrubbed before the line lands in the
// journal.
const redactCredentials = (line: string): string =>
  line
    .replace(/^(\S+\s+LOGIN\s+).*$/i, "$1[REDACTED]")
    .replace(/^(\S+\s+AUTHENTICATE\s+\S+)\s+.*$/i, "$1 [REDACTED]");

// Outbound allowlist. The plain `write()` path also carries FETCH response
// atoms — HEADER.FIELDS literal payload, ENVELOPE strings, BODY[HEADER] data —
// which contain real mail headers (Subject/From/To/Message-ID). Tracing every
// outbound write() would spill that into the journal on any FETCH burst.
//
// This regex keeps only IMAP framing and status lines the diagnostic actually
// needs — tag completions (OK/NO/BAD), untagged server status (`* OK …`,
// `* CAPABILITY`, `* BYE`), sequence updates without a data tuple (EXISTS /
// RECENT / EXPUNGE), and the `+` continuation prompt. Anything else outbound
// is dropped silently.
const OUTBOUND_FRAMING = new RegExp(
  [
    /^\+ /.source, // continuation ("+ go ahead", "+ idling")
    /^\* (?:OK|BAD|NO|BYE|CAPABILITY|ENABLED|PREAUTH)\b/.source,
    /^\* \d+ (?:EXISTS|RECENT|EXPUNGE)\s*$/.source,
    /^[A-Za-z0-9]+ (?:OK|BAD|NO) /.source,
  ].join("|")
);

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
    if (direction === "in" && !INBOUND_COMMAND.test(raw)) continue;
    if (direction === "out" && !OUTBOUND_FRAMING.test(raw)) continue;
    const sanitized = direction === "in" ? redactCredentials(raw) : raw;
    logger.info(`IMAP wire ${direction}`, {
      component: "imap.trace",
      sessionId,
      line: clip(sanitized),
    });
  }
};

if (TRACE_ON) {
  logger.info("IMAP wire trace ENABLED via IMAP_TRACE=1", {
    component: "imap.trace",
  });
}
