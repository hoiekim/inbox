import express, { json } from "express";
import fileupload from "express-fileupload";
import session from "express-session";
import path from "path";

import { getDomain, PostgresSessionStore } from "server";
import apiRouter from "./routes";
import { startCleanupScheduler } from "./rate-limit";

export const initializeHttp = async () => {
  const app = express();

  // Trust first proxy for secure cookie detection behind reverse proxy
  if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  app.use(json({ limit: "50mb" }));
  app.use(fileupload());
  app.use(
    session({
      secret: process.env.SECRET || "secret",
      resave: true,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 1000 * 60 * 60 * 24 * 7,
      },
      store: new PostgresSessionStore()
    })
  );

  app.use("/api", apiRouter);

  const clientPath = path.resolve(__dirname, "../../../../build/client");
  app.use(express.static(clientPath));

  app.get("*", (req, res) => {
    res.sendFile(path.join(clientPath, "index.html"));
  });

  const domain = getDomain();
  const port = process.env.PORT || 3004;

  await new Promise((res) =>
    app.listen(port, () => {
      console.info(`${domain} mail server is listening`);
      res(undefined);
    })
  );

  // Start cleanup scheduler for rate limit data
  startCleanupScheduler();

  return app;
};

export * from "./routes";
