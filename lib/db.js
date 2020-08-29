const fetch = require("node-fetch");
require("dotenv").config();

const db = {};

const ES_HOST = process.env.ES_HOST || "http://127.0.0.1:9200";

const authorization =
  "Basic " + Buffer.from(`elastic:${process.env.ELASTIC}`).toString("base64");

const sendESRequest = (path, method, body) => {
  const options = {
    method,
    headers: {
      Authorization: authorization,
      "content-type": "application/json",
    },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  return fetch(`${ES_HOST}${path}`, options).then((r) => r.json());
};

db.initialize = async () => {
  await sendESRequest("/mails", "DELETE");
  await sendESRequest("/mails", "PUT", {
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
  });
};

db.writeMail = (body) => {
  return sendESRequest("/mails/_doc", "POST", body);
};

db.getMails = (account) => {
  return sendESRequest("/mails/_search", "POST", {
    query: {
      term: {
        "envelopeTo.address": account,
      },
    },
  })
    .then((r) => {
      if (!r.hits) return [];
      return r.hits.hits;
    })
    .then((r) => {
      return r.map((e) => {
        return { ...e._source, id: e._id };
      });
    });
};

db.getAccounts = () => {
  return sendESRequest("/mails/_search", "POST", {
    aggs: {
      envelopeTo: {
        terms: {
          field: "envelopeTo.address",
        },
      },
    },
  })
    .then((r) => {
      if (!r.aggregations) return [];
      return r.aggregations.envelopeTo.buckets;
    })
    .then((r) => r.map((e) => e.key));
};

db.getUnreadNo = (account) => {
  return sendESRequest("/mails/_search", "POST", {
    query: {
      bool: {
        should: [
          { match: { "envelopeTo.address": account } },
          { match: { read: false } },
        ],
      },
    },
  });
};

db.searchMail = (field, regex) => {
  return sendESRequest("/mails/_search", "POST", {
    query: {
      query_string: {
        query: `${field}: ${regex}`,
      },
    },
  });
};

db.deleteMail = (id) => {
  return sendESRequest(`/mails/_doc/${id}`, "DELETE");
};

module.exports = db;
