const fetch = require("node-fetch");
require("dotenv").config();

const authorization =
  "Basic " + Buffer.from(`elastic:${process.env.ELASTIC}`).toString("base64");

const initialize = async () => {
  await fetch(`http://127.0.0.1:9200/mails`, {
    method: "DELETE",
    headers: {
      Authorization: authorization,
    },
  });
  await fetch("http://127.0.0.1:9200/mails", {
    method: "PUT",
    headers: {
      Authorization: authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      mappings: {
        properties: {
          attachments: { type: "object" },
          "cc.value.address": { type: "keyword" },
          date: { type: "date" },
          "envelopeFrom.address": { type: "keyword" },
          "envelopeTo.address": { type: "keyword" },
          html: { type: "text" },
          subject: { type: "text" },
        },
      },
    }),
  });
};

initialize();
