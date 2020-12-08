const express = require("express");
const session = require("express-session");
const mails = require("./routes/mails");
const users = require("./routes/users");
const db = require("./lib/db");

const app = express();
app.use(express.json({ limit: "50mb" }));

require("dotenv").config();

const owner = process.env.OWNER || "My";

app.use(express.json());
app.use(
  session({
    secret: process.env.SECRET,
    resave: true,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      secure: false,
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);

app.set("view engine", "ejs");

app.get("/", (req, res) => {
  if (req.session.admin) return res.redirect("/mailbox");
  res.render("home", { owner: owner });
});

app.get("/api/accounts", mails.getAccounts);
app.get("/api/unreadNo/:account", mails.getUnreadNo);
app.get("/api/markRead/:id", mails.markRead);
app.get("/api/mails/:account", mails.getMails);

app.post("/api/mails", mails.saveMail);
app.post("/api/send", mails.sendMail);

app.delete("/api/mails/:id", mails.deleteMail);

app.get("/mailbox", (req, res) => {
  if (req.session.admin) return res.render("mailbox", { owner: owner });
  res.redirect("/");
});

app.post("/admin", users.admin);
app.delete("/admin", users.logout);

app.listen(3004, () => {
  console.log("mail.hoie.Kim server is listening");
});
