import { config } from "dotenv";

const { NODE_ENV } = process.env;
const extraEnv = NODE_ENV ? ".env." + NODE_ENV : "";
[".env", ".env.local", extraEnv].forEach((path) => config({ path }));

const paths = ["src", "build"];
const isWindows = process.platform === "win32";
if (isWindows) process.env.NODE_PATH = paths.join(";");
else process.env.NODE_PATH = paths.join(":");
require("module").Module._initPaths();

export interface UserSession {
  id: string;
  username: string;
}

declare module "express-session" {
  export interface SessionData {
    user: UserSession;
  }
}

export * from "./routes";
export * from "./lib";

import express from "express";
import fileupload from "express-fileupload";
import session from "express-session";
import path from "path";
import mails from "./routes/mails";
import users from "./routes/users";
import * as push from "./routes";
import init from "./init";
import { initializeIndex } from "./lib";
import { cleanSubscriptions, notifyNewMails } from "./routes/lib";

const nodeMailin = require("@umpacken/node-mailin");

const app = express();
app.use(express.json({ limit: "50mb" }));

const domainName = process.env.DOMAIN || "mydomain";
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

app.get("/api/domainName", mails.getDomainName);
app.get("/api/attachment/:id", mails.getAttachment);
app.get("/api/accounts", mails.getAccounts);
app.get("/api/markRead/:id", mails.markRead);
app.get("/api/markSaved/:id", mails.markSaved);
app.get("/api/mails/:account", mails.getMails);
app.get("/api/mail-body/:id", mails.getMailBody);
app.get("/api/search/:value", mails.searchMail);
app.post("/api/mails", mails.savePostMail);
app.post("/api/send", mails.sendMail);
app.delete("/api/mails/:id", mails.deleteMail);

app.get("/user", users.check);
app.post("/user/sign-in", users.signIn);
app.post("/user/send-token", users.sendToken);
app.post("/user/set-info", users.setUserInfo);
app.delete("/user", users.signOut);

app.get("/push/refresh/:id", push.refresh);
app.get("/push/publicKey", push.publicKey);
app.post("/push/subscribe", push.subscribe);

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

nodeMailin.on("message", mails.saveMail);
nodeMailin.on("error", console.error);

nodeMailin.start({
  port: 25,
  logLevel: "info"
});
