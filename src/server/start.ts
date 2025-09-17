import "./config";
import express, { json } from "express";
import net from "net";
import tls from "tls";
import fileupload from "express-fileupload";
import session from "express-session";
import path from "path";

import {
  initializeIndex,
  getDomain,
  saveMailHandler,
  initializeAdminUser,
  ElasticsearchSessionStore,
  cleanSubscriptions,
  elasticsearchIsAvailable,
  getImapListener
} from "server";

import apiRouter from "./routes";
import { readFileSync } from "fs";

const initializeElasticsearch = async () => {
  await elasticsearchIsAvailable();
  await initializeIndex();
  await initializeAdminUser();
};

const initializeExpress = async () => {
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
      store: new ElasticsearchSessionStore()
    })
  );

  app.use("/api", apiRouter);

  const clientPath = path.resolve(__dirname, "../../build/client");
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

const initializeMailin = () => {
  const nodeMailin = require("@umpacken/node-mailin");
  nodeMailin.on("message", saveMailHandler);
  nodeMailin.on("error", console.error);
  nodeMailin.start({
    port: 25,
    logLevel: "info"
  });
};

const initializeImap = async () => {
  await new Promise<void>((res) => {
    const port = 143;
    const imapListener = getImapListener(port);
    const server = net.createServer(imapListener);
    server.listen(port, () => {
      console.log(`IMAP server listening on port ${port}`);
      res();
    });
  });

  await new Promise<void>((res) => {
    const port = 993;
    const imapListener = getImapListener(port);

    const { SSL_CERTIFICATE, SSL_CERTIFICATE_KEY } = process.env;

    if (!SSL_CERTIFICATE || !SSL_CERTIFICATE_KEY) {
      console.warn("SSL certificate must be set to start IMAP over TLS.");
      res();
      return;
    }

    const tlsOptions = {
      key: readFileSync(SSL_CERTIFICATE_KEY),
      cert: readFileSync(SSL_CERTIFICATE)
    };

    const server = tls.createServer(tlsOptions, imapListener);
    server.listen(port, () => {
      console.log(`IMAP server listening on port ${port} over TLS`);
      res();
    });
  });

  return;
};

const start = async () => {
  await initializeElasticsearch();
  await initializeExpress();
  initializeMailin();
  await initializeImap();
  cleanSubscriptions();
};

start();
