require("./config")();

const express = require("express");
const fileupload = require("express-fileupload");
const session = require("express-session");
const mails = require("./routes/mails");
const users = require("./routes/users");
const nodeMailin = require("node-mailin");
const path = require("path");

const app = express();
app.use(express.json({ limit: "50mb" }));

const domainName = process.env.DOMAIN || "mydomain";
const port = process.env.PORT || 3004;

app.use(express.static(path.join(__dirname, "build")));
app.use(express.json());
app.use(fileupload());
app.use(
  session({
    secret: process.env.SECRET,
    resave: true,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "build", "index.html"));
});

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
app.post("/user/sign-up", users.signUp);
app.post("/user/set-info", users.setUserInfo);
app.delete("/user", users.signOut);

app.listen(port, () => {
  console.info(`${domainName} mail server is listening`);
});

nodeMailin.on("message", mails.saveMail);

nodeMailin.on("error", console.error);

nodeMailin.start({
  port: 25,
  logLevel: "info"
});
