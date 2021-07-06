require("./config")();

const Mail = require("./lib/mails");
const User = require("./lib/users");

Mail.initialize({
  attachments: { type: "object" },
  "cc.value.address": { type: "keyword" },
  date: { type: "date" },
  "from.value.address": { type: "keyword" },
  "to.value.address": { type: "keyword" },
  "envelopeFrom.address": { type: "keyword" },
  "envelopeTo.address": { type: "keyword" },
  html: { type: "text" },
  subject: { type: "text" },
  user: { type: "keyword" }
});

User.initialize({
  email: { type: "keyword" },
  username: { type: "keyword" },
  expiry: { type: "date" }
});
