const fetch = require("node-fetch");
require("dotenv").config();

const db = {};

const authorization =
  "Basic " + Buffer.from(`elastic:${process.env.ELASTIC}`).toString("base64");

db.writeMail = async (body) => {
  return fetch("https://elastic.hoie.kim/mails/_doc", {
    method: "POST",
    headers: {
      Authorization: authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
    .then((r) => r.json())
    .then((r) => {
      return r;
    });
};

db.getMails = async (account) => {
  return fetch(`https://elastic.hoie.kim/mails/_search`, {
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
    .then((r) => r.hits.hits)
    .then((r) => {
      return r.map((e) => {
        const result = e._source;
        result.id = e._id;
        return result;
      });
    });
};

db.getAccounts = async () => {
  return fetch(`https://elastic.hoie.kim/mails/_search`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
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
    .then((r) => r.aggregations.envelopeTo.buckets)
    .then((r) => r.map((e) => e.key));
};

db.searchMail = async (field, regex) => {
  return fetch("https://elastic.hoie.kim/mails/_search", {
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
  fetch(`https://elastic.hoie.kim/mails/_doc/${id}`, {
    method: "DELETE",
    headers: {
      Authorization: authorization,
    },
  }).then((r) => r.json());
};

module.exports = db;
