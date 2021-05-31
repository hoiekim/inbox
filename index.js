const express = require("express");
const fileupload = require("express-fileupload");
const session = require("express-session");
const mails = require("./routes/mails");
const users = require("./routes/users");
const db = require("./lib/db");
const nodeMailin = require("node-mailin");
const path = require("path");

const app = express();
app.use(express.json({ limit: "50mb" }));

require("dotenv").config();

const domain = process.env.DOMAIN || "My Domain";

app.use(express.static(path.join(__dirname, "build")));
app.use("/dist", express.static("dist"));
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
  if (req.session.admin) return res.redirect("/mailbox");
  res.sendFile(path.join(__dirname, "build", "index.html"));
});

app.get("/api/attachment/:id", mails.getAttachment);
app.get("/api/accounts", mails.getAccounts);
app.get("/api/unreadNo/:account", mails.getUnreadNo);
app.get("/api/markRead/:id", mails.markRead);
app.get("/api/mails/:account", mails.getMails);
app.get("/api/mailContent/:id", mails.getMailContent);
app.post("/api/send", mails.sendMail);
app.delete("/api/mails/:id", mails.deleteMail);

app.post("/admin", users.admin);
app.delete("/admin", users.logout);

app.listen(3004, () => {
  console.log(`${domain} mail server is listening`);
});

nodeMailin.on("message", async (connection, data, content) => {
  console.log(
    "Reacieved an email",
    `From: ${data.envelopeFrom}`,
    `To: ${data.evelopeTo}`,
    new Date(Date.now())
  );
  await db.saveMail({ ...data, read: false, label: undefined });
});

nodeMailin.start({
  port: 25,
  logLevel: "info"
});
