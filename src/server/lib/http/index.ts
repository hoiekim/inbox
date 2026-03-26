import express, { json } from "express";
import fileupload from "express-fileupload";
import session from "express-session";
import path from "path";

import { getDomain, PostgresSessionStore } from "server";
import apiRouter from "./routes";
import { startCleanupScheduler } from "./rate-limit";

export const initializeHttp = async () => {
  const app = express();

  // Trust the reverse proxy (nginx) so req.ip resolves to the real client IP.
  //
  // With "trust proxy 1" (hop count), Express strips the rightmost XFF entry
  // as the proxy hop. But nginx sets X-Forwarded-For to the client IP only —
  // it does not append itself — so Express strips the only entry and falls back
  // to the Docker bridge gateway IP (e.g. 172.20.0.2), breaking rate limiting.
  //
  // Using a subnet instead tells Express to trust any connection arriving from
  // the Docker bridge network as a proxy, so it reads req.ip from the header.
  // "loopback" covers 127.0.0.1 for local dev; the RFC-1918 range covers the
  // Docker bridge (172.x.x.x, 10.x.x.x, 192.168.x.x).
  if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", "loopback, uniquelocal");
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

  const clientPath = path.resolve(__dirname, "../../../../build/client");
  app.use(express.static(clientPath));

  app.get("*", (req, res) => {
    res.sendFile(path.join(clientPath, "index.html"));
  });

  const domain = getDomain();
  const port = process.env.PORT || 3004;

  const httpServer = await new Promise<import("http").Server>((resolve) => {
    const server = app.listen(port, () => {
      console.info(`${domain} mail server is listening`);
      resolve(server);
    });
  });

  // Start cleanup scheduler for rate limit data
  startCleanupScheduler();

  return httpServer;
};

export * from "./routes";
