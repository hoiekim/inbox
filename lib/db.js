const fetch = require("node-fetch");
const { uuid } = require("uuidv4");
const fs = require("fs");
require("dotenv").config();

const db = {};

const ELASTIC_USERNAME = process.env.ELASTIC_USERNAME || "elastic";
const ELASTIC_PASSWORD = process.env.ELASTIC_PASSWORD;
const ELASTIC_HOST = process.env.ELASTIC_HOST || "http://127.0.0.1:9200";
const ELASTIC_INDEX = process.env.ELASTIC_INDEX || "mails";

const authorization =
  "Basic " +
  Buffer.from(`${ELASTIC_USERNAME}:${ELASTIC_PASSWORD}`).toString("base64");

const sendESRequest = (path, method, body) => {
  const options = {
    method,
    headers: {
      Authorization: authorization,
      "content-type": "application/json"
    }
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  return fetch(`${ELASTIC_HOST}:${path}`, options).then((r) => r.json());
};

db.initialize = async () => {
  await sendESRequest(`/${ELASTIC_INDEX}`, "DELETE");
  await sendESRequest(`/${ELASTIC_INDEX}`, "PUT", {
    mappings: {
      properties: {
        attachments: { type: "object" },
        "cc.value.address": { type: "keyword" },
        date: { type: "date" },
        "envelopeFrom.address": { type: "keyword" },
        "envelopeTo.address": { type: "keyword" },
        html: { type: "text" },
        subject: { type: "text" }
      }
    }
  });
};

db.saveMail = (body) => {
  body.attachments.forEach((e) => {
    const id = uuid();
    fs.writeFile(`./attachments/${id}`, Buffer.from(e.content.data), (err) => {
      if (err) console.log(err);
    });
    e.content.data = id;
  });
  delete body.connection.envelope.mailFrom.args;
  delete body.envelopeFrom.args;
  delete body.envelopeTo.args;
  return sendESRequest(`/${ELASTIC_INDEX}/_doc`, "POST", body).then((r) => {
    if (r.error) {
      fs.writeFile(
        `./error/${Date.now()}`,
        JSON.stringify({ ...body, error: r.error }),
        () => {}
      );
      throw new Error(r.error);
    }
    return r;
  });
};

db.getAttachment = (id) => {
  return new Promise((res, rej) => {
    fs.readFile(`./attachments/${id}`, (err, data) => {
      if (err) rej(err);
      res(data);
    });
  });
};

db.getMails = (account) => {
  return sendESRequest(`/${ELASTIC_INDEX}/_search`, "POST", {
    _source: ["read", "date", "from", "subject"],
    query: {
      term: {
        "envelopeTo.address": account
      }
    },
    sort: { date: "desc" },
    from: 0,
    size: 10000
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

db.getMailContent = (id) => {
  return sendESRequest(`/${ELASTIC_INDEX}/_search`, "POST", {
    _source: ["html", "attachments", "messageId"],
    query: {
      term: {
        _id: id
      }
    }
  })
    .then((r) => {
      if (!r.hits) return [];
      return r.hits.hits;
    })
    .then((r) => {
      return { ...r[0]._source, id: r[0]._id };
    });
};

db.getAccounts = () => {
  const allAcounts = sendESRequest(`/${ELASTIC_INDEX}/_search`, "POST", {
    _source: ["envelopeTo.address"],
    aggs: {
      envelopeTo: {
        terms: {
          field: "envelopeTo.address",
          size: 10000
        }
      }
    }
  }).then((r) => r.aggregations.envelopeTo.buckets);

  const unreadAccounts = sendESRequest(`/${ELASTIC_INDEX}/_search`, "POST", {
    _source: ["envelopeTo.address"],
    query: {
      bool: {
        must: { match: { read: false } }
      }
    },
    aggs: {
      envelopeTo: {
        terms: {
          field: "envelopeTo.address",
          size: 10000
        }
      }
    }
  }).then((r) => r.aggregations.envelopeTo.buckets);

  return Promise.all([allAcounts, unreadAccounts]).then((r) => {
    return r[0]
      .map((e) => {
        e.doc_count = r[1].find((f) => e.key === f.key)?.doc_count || 0;
        return e;
      })
      .sort((a, b) => (a.key > b.key ? 1 : b.key > a.key ? -1 : 0));
  });
};

db.markRead = (id) => {
  return sendESRequest(`/${ELASTIC_INDEX}/_update/${id}`, "POST", {
    script: "ctx._source.read = true"
  });
};

db.searchMail = (field, regex) => {
  return sendESRequest(`/${ELASTIC_INDEX}/_search`, "POST", {
    query: {
      query_string: {
        query: `${field}: ${regex}`
      }
    }
  });
};

db.deleteMail = (id) => {
  return sendESRequest(`/${ELASTIC_INDEX}/_doc/${id}`, "DELETE");
};

module.exports = db;
