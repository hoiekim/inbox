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
import {
  isAuthRateLimited,
  isRecipientProbeRateLimited,
  recordAuthFailure,
  recordRecipientProbe,
  resetAuthFailures
} from "./auth-rate-limit";
import { addressToUsername, getUserDomain, isLocalAddress } from "./util";
import { sendAlarm } from "./alarm";
import { logger } from "./logger";
import { getTlsCredentials } from "./tls";
import { registerSmtpServer, unregisterSmtpServer } from "./smtp-registry";
import { MAX_MESSAGE_BYTES } from "./message-size";

const registerListeners = (
  server: SMTPServer,
  port: number,
  callback: () => void
) => {
  registerSmtpServer(server);

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
      msg.includes("write EPROTO") ||                         // protocol error writing to socket — client aborted during TLS
      msg.includes("TLS handshake timeout")                   // Node's own implicit-TLS handshake timeout (port 465) — client connected but never completed the handshake
    ) {
      // Still logged (at warn, not error) so a real failure hiding in this
      // bucket leaves a trace — only the page to Discord is suppressed.
      logger.warn(`SMTP Server(${port}) Error`, {}, err);
      return;
    }
    logger.error(`SMTP Server(${port}) Error`, {}, err);
    sendAlarm(
      "SMTP Server Error",
      `**Port:** ${port}\n**Error:** ${String(err)}`
    ).catch(() => undefined);
  });

  server.on("close", () => {
    unregisterSmtpServer(server);
    logger.info(`SMTP Server(${port}) closed`);
  });

  server.listen(port, callback);
};

/**
 * `smtp-server` discards the promise an async handler returns and hands the
 * command-loop continuation to `cb`, so a rejection that escapes leaves the
 * whole session unanswered rather than the one command. Every path here ends
 * in `cb`, including the failure ones.
 */
export const onAuth: SMTPServerOptions["onAuth"] = async (auth, session, cb) => {
  if (session.user) return cb(null, { user: session.user });

  const ip = session.remoteAddress ?? "unknown";

  if (isAuthRateLimited(ip)) {
    return cb(new Error("Too many failed authentication attempts"));
  }

  const { username, password } = auth;

  let pwMatches = false;
  try {
    const user = await getUser({ username });
    const signedUser = user?.getSigned();

    if (!password || !user || !signedUser) {
      await recordAuthFailure(ip);
      return cb(null, { user: undefined });
    }

    pwMatches = await bcrypt.compare(password, user.password!);
  } catch (err) {
    logger.error("SMTP: authentication lookup failed", { remoteAddress: ip }, err);
    return cb(new LookupFailedError());
  }

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

/**
 * RFC 5321 §3.5.3 gives 550 to a recipient this host is responsible for but
 * holds no mailbox for. Answered at RCPT TO rather than at DATA so the octets
 * are never transferred, and permanent so the sender bounces at once instead
 * of queueing for a mailbox that will not appear.
 */
class NoSuchMailboxError extends Error {
  responseCode = 550;

  constructor() {
    super("5.1.1 Error: no such mailbox here");
  }
}

/**
 * The mailbox `onRcptTo` accepted held nothing by the end of DATA, so it went
 * away mid-transaction. Transient, because the authoritative answer for a
 * recipient that does not exist is given one command earlier — a retry reaches
 * that 550 rather than this, and this host cannot claim authority over a state
 * change it did not observe.
 */
class MailNotStoredError extends Error {
  responseCode = 451;

  constructor() {
    super("4.2.1 Error: mailbox unavailable, try again later");
  }
}

/**
 * A lookup this host needed to answer a command did not return, so it has
 * observed nothing about the account either way. RFC 5321 §4.2.3 gives 451 to
 * a local error in processing — transient, because a permanent refusal would
 * make a sender bounce mail over an outage the sender cannot see.
 */
class LookupFailedError extends Error {
  responseCode = 451;

  constructor() {
    super("4.3.0 Error: temporary lookup failure");
  }
}

/**
 * The peer has spent its recipient-probe budget. Transient and free — no
 * lookup runs behind it, and it is answered for every local recipient alike
 * so that a throttled peer learns nothing from the difference.
 */
class TooManyProbesError extends Error {
  responseCode = 451;

  constructor() {
    super("4.7.0 Error: too many unknown recipients, try again later");
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
 * Refuses a recipient inside the served zone that maps onto no account.
 *
 * `isLocalAddress` answers by label, so every `<anything>.$EMAIL_DOMAIN` is
 * this host's to answer for, while only the labels {@link addressToUsername}
 * maps onto a real account have a mailbox behind them. Deciding that here is
 * what keeps the set of recipients answered `250` equal to the set stored for:
 * at DATA the message would already have been transferred, and the save path
 * skips an unresolvable username silently.
 *
 * A foreign recipient is not this host's to judge and passes — the relay
 * decision belongs to {@link onData}, which needs the envelope complete.
 *
 * Naming a nonexistent mailbox is answerable here or in a bounce, and a bounce
 * tells the same sender the same thing at the cost of carrying the message
 * first, so refusing early trades nothing away.
 *
 * The refusal is also a yes/no on username existence, and this listener takes
 * `RCPT TO` unauthenticated, so each one is charged to a per-IP budget that
 * prices it exactly as a failed credential is priced. Past the budget the
 * answer is a uniform transient refusal and no lookup runs, which is what
 * bounds the connection-pool draw an unauthenticated peer can cause.
 */
export const onRcptTo: SMTPServerOptions["onRcptTo"] = async (
  address: SMTPServerAddress,
  session: SMTPServerSession,
  cb: (err?: Error | null) => void
) => {
  const ip = session.remoteAddress ?? "unknown";
  try {
    const { EMAIL_DOMAIN } = process.env;
    if (!EMAIL_DOMAIN) return cb();
    if (!isLocalAddress(address.address, EMAIL_DOMAIN)) return cb();

    if (isRecipientProbeRateLimited(ip)) return cb(new TooManyProbesError());

    const username = addressToUsername(address.address);
    const user = username ? await getUser({ username }) : undefined;
    if (user) return cb();

    logger.warn("SMTP: refused a recipient with no mailbox", {
      remoteAddress: ip,
      username
    });
    await recordRecipientProbe(ip);
    return cb(new NoSuchMailboxError());
  } catch (err) {
    logger.error("SMTP: recipient lookup failed", { remoteAddress: ip }, err);
    return cb(new LookupFailedError());
  }
};

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
  /**
   * Disarms the ceiling watcher and reads the rest of DATA out without
   * holding it. Every path that answers the transaction calls this first: the
   * watcher answers through the same `cb`, and `smtp-server` registers one
   * end-of-data listener per `cb` it hands out, so a second answer puts a
   * second reply on the wire and resumes command parsing a transaction early.
   */
  drain: () => void;
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
 * never ends. And no cut is silent: `mailparser` settles on an `error` but not
 * on the `close` that a bare `destroy()` emits, so a silent cut leaves its
 * promise pending and everything it accumulated reachable until the connection
 * goes away. Refusals are still answered through `cb`, which is in hand the
 * whole time, and never through that error.
 */
const boundMessageSize = (
  source: SMTPServerDataStream,
  session: SMTPServerSession,
  cb: (err?: Error | null) => void
): BoundedMessage => {
  const bounded = new PassThrough();
  // The outgoing handler reaches `simpleParser` only after a user lookup, so a
  // refusal can destroy this before anything is listening.
  bounded.on("error", () => {});
  const message: BoundedMessage = {
    stream: bounded,
    refused: false,
    drain: () => {
      message.refused = true;
      bounded.destroy(new Error("message refused"));
      source.resume();
    }
  };
  let bytes = 0;

  const refuse = (err: Error) => {
    message.drain();
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
    stream.resume();
    return cb(new Error("Email service not configured"));
  }

  const isIncomingEmail = session.envelope.rcptTo.some((addr) => {
    return isLocalAddress(addr.address, EMAIL_DOMAIN);
  });

  // `mailFrom` is a value any sender chooses freely, so a local one selects
  // submission only on a session that authenticated. Without that, inbound mail
  // whose envelope sender sits under the served zone — a forwarder, a bounce, a
  // spoof — is routed to submission and refused, and the genuine relay probe
  // (local sender, foreign recipient, no auth) draws the transient reply that
  // invites the retry rather than the permanent one this host owes it.
  const from = session.envelope.mailFrom;
  const isOutgoingEmail =
    !!session.user &&
    typeof from !== "boolean" &&
    isLocalAddress(from.address, EMAIL_DOMAIN);

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
      const stored = await saveMailHandler(null, mail, { remoteAddress });
      if (message.refused) return;

      // `onRcptTo` refuses the recipients this cannot store for, so a zero here
      // is a mailbox that went away mid-transaction. Answering an error keeps
      // the 250 from outrunning the write in every case, including one the
      // recipient check has no way to see.
      if (stored === 0) {
        logger.warn("SMTP: accepted DATA that stored into no mailbox", {
          remoteAddress
        });
        message.drain();
        return cb(new MailNotStoredError());
      }

      cb();
    })
    .catch((err) => {
      if (message.refused) return;
      logger.error("Error parsing email", {}, err);
      message.drain();
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
      message.drain();
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
    if (message.refused) return;
    cb();
  } catch (err) {
    if (message.refused) return;
    message.drain();
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
    onRcptTo,
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
