require("./config")();

const Mail = require("./routes/lib/mails");
const User = require("./routes/lib/users");

Mail.initialize({
  attachments: {
    type: "object",
    properties: {
      content: {
        type: "object",
        properties: { data: { type: "keyword" } }
      }
    }
  },
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
