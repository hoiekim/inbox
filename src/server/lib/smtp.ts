import bcrypt from "bcrypt";
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
    console.error("SMTP Server Error:", err);
  });

  server.on("close", () => {
    console.log("SMTP Server closed");
  });

  server.listen(port, callback);
};

const onAuth: SMTPServerOptions["onAuth"] = async (auth, session, cb) => {
  if (session.user) return cb(null, { user: session.user });
  const { username, password } = auth;
  const user = await getUser({ username });
  const signedUser = user?.getSigned();
  if (!password || !user || !signedUser) return cb(null);
  const pwMatches = await bcrypt.compare(password, user.password!);
  if (!pwMatches) return cb(null);
  cb(null, { user: username });
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

      await saveMailHandler(null, mail);
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
  await new Promise<void>((res) => {
    const port = 25;
    const server = new SMTPServer({
      secure: false,
      authOptional: true,
      onAuth,
      onData: onDataIncoming
    });
    registerListeners(server, port, () => {
      console.log(`SMTP server listening on port ${port} (incoming)`);
      res();
    });
  });

  await new Promise<void>((res) => {
    const port = 465;
    const { SSL_CERTIFICATE, SSL_CERTIFICATE_KEY } = process.env;

    if (!SSL_CERTIFICATE || !SSL_CERTIFICATE_KEY) {
      console.warn("SMTP: SSL certificate not found.");
      res();
      return;
    }

    const tlsOptions = {
      key: readFileSync(SSL_CERTIFICATE_KEY),
      cert: readFileSync(SSL_CERTIFICATE)
    };

    const server = new SMTPServer({
      secure: true,
      authOptional: false,
      ...tlsOptions,
      onAuth,
      onData: onDataOutgoing
    });
    registerListeners(server, port, () => {
      console.log(`SMTP server listening on port ${port} over TLS (outgoing)`);
      res();
    });
  });

  return;
};
