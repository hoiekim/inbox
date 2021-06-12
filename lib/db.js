const fetch = require("node-fetch");
const uuid = require("uuid");
const fs = require("fs");
require("dotenv").config();

const db = {};

const domainName = process.env.DOMAIN || "mydomain";

const ELASTIC_USERNAME = process.env.ELASTIC_USERNAME || "elastic";
const ELASTIC_PASSWORD = process.env.ELASTIC_PASSWORD || "";
const ELASTIC_HOST = process.env.ELASTIC_HOST || "http://127.0.0.1:9200";
const ELASTIC_INDEX = process.env.ELASTIC_INDEX || "mails";

const Authorization =
  "Basic " +
  Buffer.from(`${ELASTIC_USERNAME}:${ELASTIC_PASSWORD}`).toString("base64");

const sendESRequest = (path, method, body) => {
  const options = {
    method,
    headers: {
      Authorization,
      "content-type": "application/json"
    }
  };

  if (body) {
    if (typeof body === "string") {
      options.body = body;
    } else if (Array.isArray(body)) {
      options.body = body.map(JSON.stringify).join("\n") + "\n";
    } else if (typeof body === "object") {
      options.body = JSON.stringify(body);
    }
  }

  return fetch(`${ELASTIC_HOST}:${path}`, options).then((r) => r.json());
};

db.initialize = async () => {
  console.info("Initializing index:", ELASTIC_INDEX);
  await sendESRequest("/reindex", "POST", {
    source: {
      index: ELASTIC_INDEX
    },
    dist: {
      index: "temp-for-init"
    }
  });
  await sendESRequest(`/${ELASTIC_INDEX}`, "DELETE");
  await sendESRequest(`/${ELASTIC_INDEX}`, "PUT", {
    mappings: {
      properties: {
        attachments: { type: "object" },
        "cc.value.address": { type: "keyword" },
        date: { type: "date" },
        "from.value.address": { type: "keyword" },
        "to.value.address": { type: "keyword" },
        "envelopeFrom.address": { type: "keyword" },
        "envelopeTo.address": { type: "keyword" },
        html: { type: "text" },
        subject: { type: "text" }
      }
    }
  });
  await sendESRequest("/reindex", "POST", {
    source: {
      index: "temp-for-init"
    },
    dist: {
      index: ELASTIC_INDEX
    }
  });
  await sendESRequest("/temp-for-init", "DELETE");
  console.info("Initialized index:", ELASTIC_INDEX);
};

const getAttachmentId = () => {
  const id = uuid.v4();
  if (fs.existsSync(`./attachments/${id}`)) {
    console.warn("Duplicate uuid is found");
    console.group();
    console.log(`Duplicated path: ./attachments/${id}`);
    console.log("Isn't attachments storage directory too full?");
    console.groupEnd();
    return getAttachmentId();
  } else return id;
};

db.saveMail = (body) => {
  body.attachments.forEach((e) => {
    const id = getAttachmentId();
    const content = e.content.data || e.content;
    fs.writeFile(`./attachments/${id}`, Buffer.from(content), (err) => {
      if (err) throw new Error(err);
    });
    e.content.data = id;
  });

  delete body.connection;
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

db.getMails = (account, options) => {
  const sent = options?.sent;

  let searchFiled;

  if (sent) {
    searchFiled = "from.value.address";
  } else {
    searchFiled = "envelopeTo.address";
  }

  return sendESRequest(`/${ELASTIC_INDEX}/_search`, "POST", {
    _source: ["read", "date", "from", "to", "cc", "bcc", "subject"],
    query: {
      term: {
        [searchFiled]: account
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
  const accounts = sendESRequest(`/${ELASTIC_INDEX}/_msearch`, "POST", [
    {},
    {
      _source: ["envelopeTo.address"],
      aggs: {
        envelopeTo: {
          terms: {
            field: "envelopeTo.address",
            size: 10000
          }
        }
      }
    },
    {},
    {
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
    },
    {},
    {
      _source: ["from.value.address"],
      query: { term: { "envelopeTo.address": `sent.by.me@${domainName}` } },
      aggs: {
        envelopeFrom: {
          terms: {
            field: "from.value.address",
            size: 10000
          }
        }
      }
    }
  ]);

  return accounts.then((r) => {
    if (r.error) throw new Error(JSON.stringify(r.error));

    const allAccounts = r.responses[0].aggregations.envelopeTo.buckets;
    const unreadAccounts = r.responses[1].aggregations.envelopeTo.buckets;
    const sentAccounts = r.responses[2].aggregations.envelopeFrom.buckets;

    let sentAccountIndex;

    allAccounts.forEach((e, i) => {
      if (e.key === `sent.by.me@${domainName}`) sentAccountIndex = i;
      const foundFromUnreadAccounts = unreadAccounts.find((f) => {
        if (!f.unread_doc_count) f.unread_doc_count = f.doc_count;
        e.key === f.key;
      });
      e.unread_doc_count = foundFromUnreadAccounts?.doc_count || 0;
    });

    if (sentAccountIndex !== undefined) allAccounts.splice(sentAccountIndex, 1);

    return { new: unreadAccounts, all: allAccounts, sent: sentAccounts };
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
