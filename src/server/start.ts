import { importConfig, setModulePaths } from "./config";
importConfig();
setModulePaths();

import express from "express";
import fileupload from "express-fileupload";
import session from "express-session";
import path from "path";

import {
  initializeIndex,
  cleanSubscriptions,
  usersRouter,
  mailsRouter,
  getDomain,
  saveMailHandler
} from "server";

import * as push from "./routes/push";
import init from "./init";

const nodeMailin = require("@umpacken/node-mailin");

const app = express();
app.use(express.json({ limit: "50mb" }));

const domainName = getDomain();
const port = process.env.PORT || 3004;

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

app.get("/push/refresh/:id", push.refresh);
app.get("/push/publicKey", push.publicKey);
app.post("/push/subscribe", push.subscribe);

const apiRouter = express.Router();

apiRouter.use((req, _res, next) => {
  console.info(`<${req.method}> /api${req.url}`);
  console.group();
  const date = new Date();
  const offset = date.getTimezoneOffset() / -60;
  const offsetString = (offset > 0 ? "+" : "") + offset + "H";
  console.info(`at: ${date.toLocaleString()}, ${offsetString}`);
  console.info(`from: ${req.ip}`);
  console.groupEnd();
  next();
});

apiRouter.use("/users", usersRouter);
apiRouter.use("/mails", mailsRouter);
app.use("/api", apiRouter);

const clientPath = path.resolve(__dirname, "../../build/client");
app.use(express.static(clientPath));
app.get("*", (req, res) => {
  res.sendFile(path.join(clientPath, "index.html"));
});

app.listen(port, async () => {
  await init();
  await initializeIndex();
  cleanSubscriptions();
  console.info(`${domainName} mail server is listening`);
});

nodeMailin.on("message", saveMailHandler);
nodeMailin.on("error", console.error);

nodeMailin.start({
  port: 25,
  logLevel: "info"
});
