import bcrypt from "bcryptjs";
import { readFileSync } from "fs";
import {
  SMTPServer,
  SMTPServerOptions,
  SMTPServerSession,
  SMTPServerDataStream
} from "smtp-server";
import { simpleParser } from "mailparser";
import { saveMailHandler, sendMail, getUser } from "server";
import { IncomingMail, MailDataToSend } from "common";

const registerListeners = (
  server: SMTPServer,
  port: number,
  callback: () => void
) => {
  server.on("error", (err) => {
    console.error(`SMTP Server(${port}) Error: ${err}`);
  });

  server.on("close", () => {
    console.log(`SMTP Server(${port}) closed`);
  });

  server.listen(port, callback);
};

const onAuth: SMTPServerOptions["onAuth"] = async (auth, session, cb) => {
  if (session.user) return cb(null, { user: session.user });
  const { username, password } = auth;
  const user = await getUser({ username });
  const signedUser = user?.getSigned();
  if (!password || !user || !signedUser) return cb(null, { user: undefined });
  const pwMatches = await bcrypt.compare(password, user.password!);
  if (!pwMatches) return cb(null, { user: undefined });
  cb(null, { user: username });
};

const onData = (
  stream: SMTPServerDataStream,
  session: SMTPServerSession,
  cb: (err?: Error | null) => void
) => {
  const { EMAIL_DOMAIN } = process.env;
  if (!EMAIL_DOMAIN) {
    console.warn("SMTP: EMAIL_DOMAIN not set, rejecting all emails.");
    return cb(new Error("Email service not configured"));
  }

  const isIncomingEmail = session.envelope.rcptTo.some((addr) => {
    return addr.address.endsWith(`@${EMAIL_DOMAIN}`);
  });

  const from = session.envelope.mailFrom;
  const isOutgoingEmail =
    typeof from !== "boolean" && from.address.endsWith(`@${EMAIL_DOMAIN}`);

  if (isOutgoingEmail) onDataOutgoing(stream, session, cb);
  else if (isIncomingEmail) onDataIncoming(stream, session, cb);
};

const onDataIncoming = (
  stream: SMTPServerDataStream,
  session: SMTPServerSession,
  cb: (err?: Error | null) => void
) => {
  simpleParser(stream)
    .then(async (parsed) => {
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
      console.error("Error parsing email:", err);
      cb(err);
    });
};

const onDataOutgoing = async (
  stream: SMTPServerDataStream,
  session: SMTPServerSession,
  cb: (err?: Error | null) => void
) => {
  try {
    const username = session.user;
    const user = username && (await getUser({ username }));
    const signedUser = user && user.getSigned();
    if (!username || !user || !signedUser) {
      console.warn("SMTP: Unauthenticated user attempted to send email.");
      return cb(new Error("User not authenticated"));
    }

    const parsed = await simpleParser(stream);
    const fromAddress = session.envelope.mailFrom;
    const sender =
      (fromAddress && typeof fromAddress !== "boolean"
        ? fromAddress.address
        : ""
      )?.split("@")[0] || "admin";

    const mailData = new MailDataToSend({
      to: session.envelope.rcptTo.map((addr) => addr.address).join(","),
      subject: parsed.subject || "",
      html: parsed.html || parsed.text || "",
      sender,
      senderFullName: parsed.from?.text || sender
    });

    await sendMail(signedUser, mailData);
    cb();
  } catch (err) {
    cb(err instanceof Error ? err : new Error(String(err)));
  }
};

export const initializeSmtp = async () => {
  const options: SMTPServerOptions = { authOptional: true, onAuth, onData };

  const { SSL_CERTIFICATE, SSL_CERTIFICATE_KEY } = process.env;
  const isSslAvailable = SSL_CERTIFICATE && SSL_CERTIFICATE_KEY;

  if (isSslAvailable) {
    options.key = readFileSync(SSL_CERTIFICATE_KEY);
    options.cert = readFileSync(SSL_CERTIFICATE);
  } else {
    console.warn("SMTP: SSL certificate not found.");
  }

  await new Promise<void>((res) => {
    const port = 25;
    const server = new SMTPServer({ ...options, secure: false });
    registerListeners(server, port, () => {
      console.log(`SMTP server listening on port ${port}`);
      res();
    });
  });

  if (isSslAvailable) {
    await new Promise<void>((res) => {
      const port = 465;
      const server = new SMTPServer({ ...options, secure: true });
      registerListeners(server, port, () => {
        console.log(`SMTP server listening on port ${port}`);
        res();
      });
    });

    await new Promise<void>((res) => {
      const port = 587;
      const server = new SMTPServer({
        ...options,
        secure: false,
        allowInsecureAuth: true
      });
      registerListeners(server, port, () => {
        console.log(`SMTP server listening on port ${port}`);
        res();
      });
    });
  }

  return;
};
