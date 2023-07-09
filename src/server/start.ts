import { importConfig, setModulePaths } from "./config";

importConfig();
setModulePaths();

import express, { json } from "express";
import fileupload from "express-fileupload";
import session from "express-session";

import path from "path";

import {
  initializeIndex,
  cleanSubscriptions,
  getDomain,
  saveMailHandler
} from "server";

import apiRouter from "./routes";

const nodeMailin = require("@umpacken/node-mailin");

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
    }
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

app.listen(port, async () => {
  await initializeIndex();
  cleanSubscriptions();
  console.info(`${domain} mail server is listening`);
});

nodeMailin.on("message", saveMailHandler);
nodeMailin.on("error", console.error);

nodeMailin.start({
  port: 25,
  logLevel: "info"
});
