import config from "./config";
config();

import init from "./init";
if (process.env.INIT) init();

import express from "express";
import fileupload from "express-fileupload";
import session from "express-session";
import mails from "./routes/mails";
import users from "./routes/users";
import path from "path";

const nodeMailin = require("node-mailin");

const app = express();
app.use(express.json({ limit: "50mb" }));

const domainName = process.env.DOMAIN || "mydomain";
const port = process.env.PORT || 3004;

app.use(express.static(path.join(__dirname, "build")));
app.use(express.json());
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

app.get("/api/attachment/:id", mails.getAttachment);
app.get("/api/accounts", mails.getAccounts);
app.get("/api/markRead/:id", mails.markRead);
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

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "build", "index.html"));
});

app.listen(port, () => {
  console.info(`${domainName} mail server is listening`);
});

nodeMailin.on("message", mails.saveMail);
nodeMailin.on("error", console.error);

nodeMailin.start({
  port: 25,
  logLevel: "info"
});
