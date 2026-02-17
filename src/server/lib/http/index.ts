import express, { json } from "express";
import fileupload from "express-fileupload";
import session from "express-session";
import path from "path";

import { getDomain, PostgresSessionStore } from "server";
import apiRouter from "./routes";

export const initializeHttp = async () => {
  const app = express();

  app.use(json({ limit: "50mb" }));
  app.use(fileupload());
  app.use(
    session({
      secret: process.env.SECRET || "secret",
      resave: true,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        secure: false,
        maxAge: 1000 * 60 * 60 * 24 * 7
      },
      store: new PostgresSessionStore()
    })
  );

  app.use("/api", apiRouter);

  // In production: client files are at build/client, relative to bundled server.js
  // In dev: Vite serves the client, so this only matters for production
  const clientPath = path.resolve(import.meta.dir, "client");
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

  return app;
};

export * from "./routes";
