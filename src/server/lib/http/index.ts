import express, { json } from "express";
import fileupload from "express-fileupload";
import session from "express-session";
import path from "path";

import { getDomain, PostgresSessionStore } from "server";
import apiRouter from "./routes";
import { startCleanupScheduler } from "./rate-limit";
import { logger } from "../logger";

export const initializeHttp = async () => {
  const app = express();

  // Trust first proxy for secure cookie detection behind reverse proxy.
  // (Rate limiting reads X-Real-IP directly and does not rely on req.ip.)
  if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    if (process.env.NODE_ENV === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  app.use(json({ limit: "10mb" }));
  app.use(
    fileupload({
      limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max per file
      abortOnLimit: true,
      useTempFiles: true,
      tempFileDir: "/tmp/",
    })
  );
  app.use(
    session({
      secret: process.env.SECRET || "secret",
      resave: true,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 1000 * 60 * 60 * 24 * 7
      },
      store: new PostgresSessionStore()
    })
  );

  // Security response headers (defense-in-depth)
  app.use((_req, res, next) => {
    // Restrict resource origins. 'unsafe-inline' for styles is required by React.
    // 'blob:' in img-src allows inline email images loaded as object URLs.
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        // sandbox attribute on email iframes restricts their content;
        // frame-src 'self' allows those sandboxed iframes to be embedded.
        "frame-src 'self'",
        "font-src 'self' data:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; ")
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  app.use("/api", apiRouter);

  // IMAP/SMTP auto-discovery for email clients (Thunderbird, Apple Mail, Outlook, etc.)
  // https://wiki.mozilla.org/Thunderbird:Autoconfiguration:ConfigFileFormat
  app.get("/.well-known/autoconfig/mail/config-v1.1.xml", (_req, res) => {
    const emailDomain = getDomain();
    // APP_HOSTNAME is the actual server hostname clients connect to for IMAP/SMTP.
    // EMAIL_DOMAIN is the MX-record domain used for routing — not always the same as
    // the server's hostname (e.g. MX record may use non-TLS delivery paths).
    const serverHostname = process.env.APP_HOSTNAME || emailDomain;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="${emailDomain}">
    <domain>${emailDomain}</domain>
    <displayName>${emailDomain} Mail</displayName>
    <displayShortName>${emailDomain}</displayShortName>
    <incomingServer type="imap">
      <hostname>${serverHostname}</hostname>
      <port>143</port>
      <socketType>STARTTLS</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>${serverHostname}</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.send(xml);
  });

  const clientPath = path.resolve(__dirname, "../../../../build/client");
  app.use(express.static(clientPath));

  app.get("*", (req, res) => {
    res.sendFile(path.join(clientPath, "index.html"));
  });

  const domain = getDomain();
  const port = process.env.PORT || 3004;

  const httpServer = await new Promise<import("http").Server>((resolve) => {
    const server = app.listen(port, () => {
      logger.info(`${domain} mail server is listening`);
      resolve(server);
    });
  });

  // Start cleanup scheduler for rate limit data
  startCleanupScheduler();

  return httpServer;
};

export * from "./routes";
export * from "./rate-limit";
