const fetch = require("node-fetch");
require("dotenv").config();

const db = {};

const authorization =
  "Basic " + Buffer.from(`elastic:${process.env.ELASTIC}`).toString("base64");

db.initialize = async () => {
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

db.writeMail = async (body) => {
  console.log(body);
  return fetch("http://127.0.0.1:9200/mails/_doc", {
    method: "POST",
    headers: {
      Authorization: authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
    .then((r) => r.json())
    .then((r) => {
      console.log(r);
      return r;
    });
};

db.getMails = async (account) => {
  return fetch(`http://127.0.0.1:9200/mails/_search`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: {
        term: {
          "envelopeTo.address": account,
        },
      },
    }),
  })
    .then((r) => r.json())
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

db.getAccounts = async () => {
  return fetch(`http://127.0.0.1:9200/mails/_search`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      _source: ["envelopeTo.address"],
      aggs: {
        envelopeTo: {
          terms: {
            field: "envelopeTo.address",
          },
        },
      },
    }),
  })
    .then((r) => {
      return r.json();
    })
    .then((r) => {
      if (!r.aggregations) return [];
      return r.aggregations.envelopeTo.buckets;
    })
    .then((r) => r.map((e) => e.key));
};

db.getUnreadNo = async (account) => {
  return fetch("http://127.0.0.1:9200/mails/_search", {
    method: "POST",
    headers: {
      Authorization: authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      _source: ["envelopeTo.address"],
      query: {
        bool: {
          must: [
            { match: { "envelopeTo.address": account } },
            { match: { read: false } },
          ],
        },
      },
    }),
  })
    .then((r) => r.json())
    .then((r) => r.hits.total.value);
};

db.markRead = async (id) => {
  fetch(`http://127.0.0.1:9200/mails/_update/${id}`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      script: "ctx._source.read = true",
    }),
  }).then((r) => r.json());
};

db.searchMail = async (field, regex) => {
  return fetch("http://127.0.0.1:9200/mails/_search", {
    method: "POST",
    headers: {
      Authorization: authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: {
        query_string: {
          query: `${field}: ${regex}`,
        },
      },
    }),
  })
    .then((r) => r.json())
    .then((r) => {
      console.log(r);
      return r;
    });
};

db.deleteMail = async (id) => {
  fetch(`http://127.0.0.1:9200/mails/_doc/${id}`, {
    method: "DELETE",
    headers: {
      Authorization: authorization,
    },
  }).then((r) => r.json());
};

module.exports = db;
