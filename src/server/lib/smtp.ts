import bcrypt from "bcryptjs";
import { readFileSync } from "fs";
import { PassThrough, Readable } from "stream";
import {
  SMTPServer,
  SMTPServerAddress,
  SMTPServerOptions,
  SMTPServerSession,
  SMTPServerDataStream
} from "smtp-server";
import { simpleParser, AddressObject, EmailAddress } from "mailparser";
import {
  saveMailHandler,
  sendMail,
  getUser,
  ADMIN_RO_USERNAME
} from "server";
import { IncomingMail, MailDataToSend } from "common";
import { isAuthRateLimited, recordAuthFailure, resetAuthFailures } from "./auth-rate-limit";
import { getUserDomain } from "./util";
import { sendAlarm } from "./alarm";
import { logger } from "./logger";
import { getTlsCredentials } from "./tls";
import { MAX_MESSAGE_BYTES } from "./message-size";

const registerListeners = (
  server: SMTPServer,
  port: number,
  callback: () => void
) => {
  server.on("error", (err) => {
    // Suppress noise from external port scanners and misconfigured clients.
    // These errors originate from the remote side failing TLS negotiation —
    // they do not indicate a server-side problem.
    //
    // Strategy: suppress by OpenSSL function name in the error string.
    // - tls_early_post_process_client_hello: all errors at the TLS ClientHello stage
    //   (unsupported protocol, version too low, no suitable signature algorithm, etc.)
    //   These all mean the client's TLS capabilities are incompatible with the server.
    // - extract_keyshares: TLS 1.3 key exchange failures (bad key share, etc.)
    // - Plus a few smtp-server-level strings for connection-drop cases.
    const msg = err.message ?? "";
    if (
      // All errors from TLS handshake/negotiation OpenSSL functions — these are
      // client-side incompatibilities, not server bugs. Matching by function name
      // covers all variants (unsupported protocol, version too low, no shared cipher,
      // no suitable signature algorithm, etc.) without enumerating each string.
      msg.includes("tls_early_post_process_client_hello") || // ClientHello stage rejections
      msg.includes("tls_post_process_client_hello") ||       // post-ClientHello cipher/extension failures
      msg.includes("tls_validate_record_header") ||          // malformed/wrong-protocol record header
      msg.includes("extract_keyshares") ||                   // TLS 1.3 key exchange failure (bad key share)
      msg.includes("final_key_share") ||                     // TLS 1.3 key exchange failure (no suitable key share)
      msg.includes("tls_choose_sigalg") ||                   // signature algorithm negotiation failure
      msg.includes("tls_get_more_records") ||                // oversized/malformed TLS record
      // smtp-server-level strings for connection-drop cases
      msg.includes("Socket closed") ||                       // client disconnected before TLS handshake
      msg.includes("Failed to establish TLS session") ||     // smtp-server generic TLS failure wrapper
      msg.includes("read ECONNRESET") ||                      // client dropped connection mid-handshake
      msg.includes("read ETIMEDOUT") ||                       // client connected but stopped responding (scanner idle timeout)
      msg.includes("write EPROTO")                            // protocol error writing to socket — client aborted during TLS
    ) return;
    logger.error(`SMTP Server(${port}) Error`, {}, err);
    sendAlarm(
      "SMTP Server Error",
      `**Port:** ${port}\n**Error:** ${String(err)}`
    ).catch(() => undefined);
  });

  server.on("close", () => {
    logger.info(`SMTP Server(${port}) closed`);
  });

  server.listen(port, callback);
};

export const onAuth: SMTPServerOptions["onAuth"] = async (auth, session, cb) => {
  if (session.user) return cb(null, { user: session.user });

  const ip = session.remoteAddress ?? "unknown";

  if (isAuthRateLimited(ip)) {
    return cb(new Error("Too many failed authentication attempts"));
  }

  const { username, password } = auth;
  const user = await getUser({ username });
  const signedUser = user?.getSigned();

  if (!password || !user || !signedUser) {
    await recordAuthFailure(ip);
    return cb(null, { user: undefined });
  }

  const pwMatches = await bcrypt.compare(password, user.password!);
  if (!pwMatches) {
    await recordAuthFailure(ip);
    return cb(null, { user: undefined });
  }

  resetAuthFailures(ip);
  // Audit line names the original credential. Read-only sessions pass this
  // gate and are refused later at the single mutating gate this surface
  // has, `onMailFrom` (below) — matching HTTP and IMAP where the read-only
  // credential logs in but is refused at every write.
  if (username === ADMIN_RO_USERNAME) {
    logger.info("SMTP AUTH success (read-only)", { authenticatedAs: username, ip });
  }
  cb(null, { user: username });
};

/**
 * Refuses MAIL FROM for a session authenticated with the read-only credential
 * — SMTP submission is a mutating action (writes a sent-mail row and hands the
 * message to Mailgun for non-local recipients). 550 keeps this in the "policy
 * denied" family rather than the "server error" family that would train
 * clients to retry.
 */
export const onMailFrom: SMTPServerOptions["onMailFrom"] = (
  _address: SMTPServerAddress,
  session: SMTPServerSession,
  cb: (err?: Error | null) => void
) => {
  if (session.user === ADMIN_RO_USERNAME) {
    const err = new Error("READ-ONLY user cannot send") as Error & {
      responseCode?: number;
    };
    err.responseCode = 550;
    return cb(err);
  }
  return cb();
};

/**
 * RFC 5321 §3.6.1 gives 550 to a message this host will not relay — neither
 * the sender nor any recipient is local. 550 keeps it in the "policy denied"
 * family rather than the "server error" family that would train a client to
 * retry, matching `onMailFrom`'s refusal above.
 */
class RelayDeniedError extends Error {
  responseCode = 550;

  constructor() {
    super("Error: relay access denied");
  }
}

/** RFC 5321 §4.2.3 gives 552 to a message that exceeds the fixed maximum size. */
class MessageTooLargeError extends Error {
  responseCode = 552;

  constructor() {
    super(
      `Error: message exceeds fixed maximum message size ${MAX_MESSAGE_BYTES}`
    );
  }
}

/**
 * A DATA transaction, carried to the parser only as far as the ceiling.
 *
 * `refused` is read after every `await` the handlers do: the reply has already
 * gone out by then, so the side effect that `await` was leading up to must not
 * run, and nothing may answer the transaction a second time.
 */
interface BoundedMessage {
  stream: Readable;
  refused: boolean;
}

/**
 * Bounds what one DATA transaction can make the process hold.
 *
 * `smtp-server` offers no enforcement to lean on. Its `size` option makes
 * `EHLO` advertise `SIZE` and refuses a `MAIL FROM` that declares more, but a
 * sender that declares nothing still streams whatever it likes: the library
 * computes `stream.sizeExceeded` in `_endDataMode`, once the final octet has
 * already been written, and never acts on it. So the count is kept here, where
 * the octets arrive, and the parser is cut off at the ceiling rather than told
 * about it afterwards.
 *
 * Two shapes this deliberately avoids. The source keeps flowing past the cut,
 * because the reply is only sent once DATA ends and a source nobody reads
 * never ends. And every cut destroys without an error: the outgoing handler
 * reaches `simpleParser` only after a user lookup, so an error emitted here
 * can land on a stream nothing is listening to yet. Refusals are answered
 * through `cb` instead, which is in hand the whole time.
 */
const boundMessageSize = (
  source: SMTPServerDataStream,
  session: SMTPServerSession,
  cb: (err?: Error | null) => void
): BoundedMessage => {
  const bounded = new PassThrough();
  const message: BoundedMessage = { stream: bounded, refused: false };
  let bytes = 0;

  const refuse = (err: Error) => {
    message.refused = true;
    bounded.destroy();
    cb(err);
  };

  source.on("data", (chunk: Buffer) => {
    if (message.refused) return;

    bytes += chunk.length;
    if (bytes > MAX_MESSAGE_BYTES) {
      logger.warn("SMTP: refused a message over the maximum size", {
        remoteAddress: session.remoteAddress,
        maxBytes: MAX_MESSAGE_BYTES
      });
      refuse(new MessageTooLargeError());
      // Read the rest of DATA without holding it: the reply lands when the
      // transaction ends, and a source nobody reads never ends.
      source.resume();
      return;
    }

    if (!bounded.write(chunk)) {
      source.pause();
      bounded.once("drain", () => source.resume());
    }
  });

  source.once("end", () => {
    if (!message.refused) bounded.end();
  });

  source.once("error", (err) => {
    if (message.refused) return;
    logger.error("SMTP: DATA stream failed", {}, err);
    refuse(err);
  });

  return message;
};

export const onData = (
  stream: SMTPServerDataStream,
  session: SMTPServerSession,
  cb: (err?: Error | null) => void
) => {
  const { EMAIL_DOMAIN } = process.env;
  if (!EMAIL_DOMAIN) {
    logger.warn("SMTP: EMAIL_DOMAIN not set, rejecting all emails.");
    // Every refusal below reads the transaction out before answering. The
    // library transmits a reply only once DATA ends, and DATA ends only once
    // the source is read — so answering through `cb` alone generates a reply
    // that is never sent, and holds one of `maxClients` until the socket
    // timeout.
    stream.resume();
    return cb(new Error("Email service not configured"));
  }

  const isIncomingEmail = session.envelope.rcptTo.some((addr) => {
    return addr.address.endsWith(`@${EMAIL_DOMAIN}`);
  });

  const from = session.envelope.mailFrom;
  const isOutgoingEmail =
    typeof from !== "boolean" && from.address.endsWith(`@${EMAIL_DOMAIN}`);

  if (!isIncomingEmail && !isOutgoingEmail) {
    logger.warn("SMTP: refused to relay a message with no local party", {
      remoteAddress: session.remoteAddress
    });
    stream.resume();
    return cb(new RelayDeniedError());
  }

  const message = boundMessageSize(stream, session, cb);
  if (isOutgoingEmail) onDataOutgoing(message, session, cb);
  else onDataIncoming(message, session, cb);
};

const onDataIncoming = (
  message: BoundedMessage,
  session: SMTPServerSession,
  cb: (err?: Error | null) => void
) => {
  simpleParser(message.stream)
    .then(async (parsed) => {
      if (message.refused) return;

      const mail: IncomingMail = {
        messageId: parsed.messageId,
        from: parsed.from,
        to: parsed.to,
        cc: parsed.cc,
        bcc: parsed.bcc,
        replyTo: parsed.replyTo,
        envelopeFrom: session.envelope.mailFrom || undefined,
        envelopeTo: session.envelope.rcptTo.map((addr) => ({
          address: addr.address
        })),
        subject: parsed.subject,
        date: parsed.date?.toISOString(),
        html: parsed.html || parsed.text,
        text: parsed.text,
        attachments: parsed.attachments?.map((att) => ({
          filename: att.filename || "attachment",
          contentType: att.contentType,
          content: att.content,
          size: att.size
        }))
      };

      // Extract remote address for spam DNSBL checks
      const remoteAddress = session.remoteAddress;
      await saveMailHandler(null, mail, { remoteAddress });
      cb();
    })
    .catch((err) => {
      if (message.refused) return;
      logger.error("Error parsing email", {}, err);
      message.stream.resume();
      cb(err);
    });
};

const splitAddress = (address: string) => {
  const at = address.lastIndexOf("@");
  if (at === -1) return undefined;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!local || !domain || local.includes("@")) return undefined;
  return { local, domain };
};

const addressList = (
  header: AddressObject | AddressObject[] | undefined
): string[] => {
  const flatten = (entries: EmailAddress[]): string[] =>
    entries.flatMap((entry) =>
      entry.group ? flatten(entry.group) : [entry.address ?? ""]
    );
  if (!header) return [];
  const objects = Array.isArray(header) ? header : [header];
  return objects.flatMap((object) => flatten(object.value)).filter(Boolean);
};

interface OutgoingSender {
  sender: string;
  recipients: string[];
}

/**
 * Resolves which of the user's accounts an SMTP submission is sent as, given
 * the parsed `To:` addresses in `addressedTo`.
 *
 * Clients strip `Bcc:` before DATA and carry those addresses only in the
 * envelope, so a Cc and a Bcc cannot be told apart here and both select. `To:`
 * is the one recipient field that always survives into the message, which is
 * what makes excluding it possible.
 */
export const resolveOutgoingSender = (
  username: string,
  userDomain: string,
  from: { header?: string; envelope?: string },
  recipients: string[],
  addressedTo: string[]
): OutgoingSender => {
  const normalize = (address: string | undefined) =>
    address?.trim().toLowerCase();
  const accountOf = (address: string | undefined) => {
    const parts = splitAddress(normalize(address) ?? "");
    if (!parts || parts.domain !== userDomain.toLowerCase()) return undefined;
    return parts.local;
  };

  const fromAccount = accountOf(from.header) || accountOf(from.envelope);
  if (fromAccount && fromAccount !== username) {
    return { sender: fromAccount, recipients };
  }

  const addressed = new Set(addressedTo.map(normalize));
  const selected = recipients.findIndex((address) => {
    const account = accountOf(address);
    return (
      !!account && account !== username && !addressed.has(normalize(address))
    );
  });

  if (selected === -1 || recipients.length === 1) {
    const envelopeAccount = splitAddress(normalize(from.envelope) ?? "")?.local;
    return {
      sender: fromAccount || envelopeAccount || username,
      recipients
    };
  }

  return {
    sender: accountOf(recipients[selected])!,
    recipients: recipients.filter((_, index) => index !== selected)
  };
};

/**
 * Splits the SMTP envelope recipients into To / Cc / Bcc.
 *
 * A client puts Bcc addresses only in `RCPT TO` and strips the `Bcc:` header
 * out of DATA, so an envelope recipient that neither header names is a Bcc.
 * The envelope decides who is delivered to; the headers only decide which of
 * the three lists each recipient belongs in.
 *
 * @example
 * splitEnvelopeRecipients(["a@x.com", "b@x.com"], ["a@x.com"], [])
 * // => { to: ["a@x.com"], cc: [], bcc: ["b@x.com"] }
 */
export const splitEnvelopeRecipients = (
  recipients: string[],
  addressedTo: string[],
  addressedCc: string[]
) => {
  const normalize = (address: string) => address.trim().toLowerCase();
  const toHeader = new Set(addressedTo.map(normalize));
  const ccHeader = new Set(addressedCc.map(normalize));

  const to: string[] = [];
  const cc: string[] = [];
  const bcc: string[] = [];

  recipients.forEach((address) => {
    const key = normalize(address);
    if (toHeader.has(key)) to.push(address);
    else if (ccHeader.has(key)) cc.push(address);
    else bcc.push(address);
  });

  return { to, cc, bcc };
};

const onDataOutgoing = async (
  message: BoundedMessage,
  session: SMTPServerSession,
  cb: (err?: Error | null) => void
) => {
  try {
    const username = session.user;
    const user = username && (await getUser({ username }));
    if (message.refused) return;

    const signedUser = user && user.getSigned();
    if (!username || !user || !signedUser) {
      logger.warn("SMTP: Unauthenticated user attempted to send email.");
      message.stream.resume();
      return cb(new Error("User not authenticated"));
    }

    const parsed = await simpleParser(message.stream);
    if (message.refused) return;

    const mailFrom = session.envelope.mailFrom;
    const envelopeFrom =
      mailFrom && typeof mailFrom !== "boolean" ? mailFrom.address : undefined;
    const { sender, recipients } = resolveOutgoingSender(
      username,
      getUserDomain(username),
      { header: parsed.from?.value?.[0]?.address, envelope: envelopeFrom },
      session.envelope.rcptTo.map((addr) => addr.address),
      addressList(parsed.to)
    );

    const { to, cc, bcc } = splitEnvelopeRecipients(
      recipients,
      addressList(parsed.to),
      addressList(parsed.cc)
    );

    const mailData = new MailDataToSend({
      to: to.join(","),
      cc: cc.join(",") || undefined,
      bcc: bcc.join(",") || undefined,
      subject: parsed.subject || "",
      html: parsed.html || parsed.text || "",
      sender,
      senderFullName: parsed.from?.value?.[0]?.name || sender
    });

    await sendMail(signedUser, mailData);
    cb();
  } catch (err) {
    if (message.refused) return;
    message.stream.resume();
    cb(err instanceof Error ? err : new Error(String(err)));
  }
};

const SMTP_MAX_CLIENTS = 100;

export const initializeSmtp = async () => {
  const servers: SMTPServer[] = [];

  const options: SMTPServerOptions = {
    authOptional: true,
    onAuth,
    onMailFrom,
    onData,
    maxClients: SMTP_MAX_CLIENTS,
    size: MAX_MESSAGE_BYTES
  };

  const credentials = getTlsCredentials();
  const isSslAvailable = credentials.state === "available";

  if (credentials.state === "unreadable") {
    // Same reasoning as the IMAP listener: TLS was configured and cannot be
    // served, so this is an operator error that has to page rather than sit in
    // a warn line while the server accepts plaintext auth.
    logger.error("SMTP: SSL certificate files not readable — starting without TLS", {
      cert: credentials.cert,
      key: credentials.key,
    });
    sendAlarm(
      "TLS certificate not readable",
      `SMTP is configured for TLS but cannot read its certificate, and is serving cleartext only.\n**cert:** ${credentials.cert}\n**key:** ${credentials.key}`,
      "tls-cert-unreadable-smtp"
    ).catch(() => undefined);
  }

  if (credentials.state === "available") {
    options.key = readFileSync(credentials.key);
    options.cert = readFileSync(credentials.cert);
    // Broaden TLS compatibility for external MTAs (e.g. Postfix, Exchange) that
    // may offer cipher suites excluded from OpenSSL 3's stricter defaults.
    // TLSv1.2 minimum is maintained; known-weak ciphers remain disabled.
    options.minVersion = "TLSv1.2";
    options.ciphers = "HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA";
  } else if (credentials.state === "unconfigured") {
    logger.warn("SMTP: SSL certificate not configured.");
  }

  const smtpServer = await new Promise<SMTPServer>((res) => {
    const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 25;
    const server = new SMTPServer({ ...options, secure: false });
    registerListeners(server, port, () => {
      logger.info(`SMTP server listening on port ${port}`);
      res(server);
    });
  });
  servers.push(smtpServer);

  if (isSslAvailable) {
    const smtpsServer = await new Promise<SMTPServer>((res) => {
      const port = process.env.SMTPS_PORT ? parseInt(process.env.SMTPS_PORT, 10) : 465;
      const server = new SMTPServer({ ...options, secure: true });
      registerListeners(server, port, () => {
        logger.info(`SMTP server listening on port ${port}`);
        res(server);
      });
    });
    servers.push(smtpsServer);

    const submissionServer = await new Promise<SMTPServer>((res) => {
      const port = process.env.SMTP_SUBMISSION_PORT ? parseInt(process.env.SMTP_SUBMISSION_PORT, 10) : 587;
      const server = new SMTPServer({
        ...options,
        secure: false,
        allowInsecureAuth: true
      });
      registerListeners(server, port, () => {
        logger.info(`SMTP server listening on port ${port}`);
        res(server);
      });
    });
    servers.push(submissionServer);
  }

  return servers;
};
