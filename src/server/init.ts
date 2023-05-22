import { Mail, User } from "./routes";

const init = () => {
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
    label: { type: "keyword" },
    insight: {
      type: "nested",
      properties: {
        summary: { type: "text" },
        action_items: { type: "text" },
        suggested_reply: { type: "text" }
      }
    }
  });

  User.initialize({
    email: { type: "keyword" },
    username: { type: "keyword" },
    expiry: { type: "date" }
  });
};

export default init;
