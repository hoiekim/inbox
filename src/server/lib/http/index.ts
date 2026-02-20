import express, { json } from "express";
import fileupload from "express-fileupload";
import session from "express-session";
import path from "path";

import { getDomain, PostgresSessionStore } from "server";
import apiRouter from "./routes";

// Validate session secret at module load
if (!process.env.SECRET) {
  if (process.env.NODE_ENV === "production") {
    console.error("❌ FATAL: SECRET env var must be set in production!");
    process.exit(1);
  }
  console.warn("⚠️  WARNING: SECRET env var not set. Using insecure default.");
}
const sessionSecret = process.env.SECRET || "secret";

export const initializeHttp = async () => {
  const app = express();

  app.use(json({ limit: "50mb" }));
  app.use(fileupload());
  app.use(
    session({
      secret: sessionSecret,
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

  return app;
};

export * from "./routes";
