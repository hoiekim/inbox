require("./config")();

const Mail = require("./routes/lib/mails");
const User = require("./routes/lib/users");

module.exports = () => {
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
    cc: {
      type: "object",
      properties: {
        value: {
          type: "object",
          properties: { address: { type: "keyword" } }
        }
      }
    },
    from: {
      type: "object",
      properties: {
        value: {
          type: "object",
          properties: { address: { type: "keyword" } }
        }
      }
    },
    to: {
      type: "object",
      properties: {
        value: {
          type: "object",
          properties: { address: { type: "keyword" } }
        }
      }
    },
    envelopeFrom: {
      type: "object",
      properties: { address: { type: "keyword" } }
    },
    envelopeTo: {
      type: "object",
      properties: { address: { type: "keyword" } }
    },
    date: { type: "date" },
    html: { type: "text" },
    text: { type: "text" },
    subject: { type: "text" },
    user: { type: "keyword" },
    read: { type: "boolean" },
    label: { type: "keyword" }
  });

  User.initialize({
    email: { type: "keyword" },
    username: { type: "keyword" },
    expiry: { type: "date" }
  });
};
