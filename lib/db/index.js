const Elastic = require("./components/elastic");
const uuid = require("uuid");
const fs = require("fs");
require("dotenv").config();

const domainName = process.env.DOMAIN || "mydomain";

const ELASTIC_HOST = process.env.ELASTIC_HOST || "http://127.0.0.1:9200";
const ELASTIC_USERNAME = process.env.ELASTIC_USERNAME || "elastic";
const ELASTIC_PASSWORD = process.env.ELASTIC_PASSWORD || "";
const ELASTIC_INDEX = process.env.ELASTIC_INDEX || "mails";

const db = new Elastic(
  ELASTIC_HOST,
  ELASTIC_USERNAME,
  ELASTIC_PASSWORD,
  ELASTIC_INDEX
);

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

  return db.request("_doc", "POST", body).then((r) => {
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
  let searchFiled, query;

  if (options.sent) {
    searchFiled = "from.value.address";
  } else {
    searchFiled = "envelopeTo.address";
  }

  if (options.new) {
    query = {
      bool: {
        must: [{ term: { [searchFiled]: account } }, { term: { read: false } }]
      }
    };
  } else {
    query = {
      term: {
        [searchFiled]: account
      }
    };
  }

  return db
    .request("_search", "POST", {
      _source: ["read", "date", "from", "to", "cc", "bcc", "subject"],
      query,
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
  return db
    .request("_search", "POST", {
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
  const accounts = db.request("_msearch", "POST", [
    {},
    {
      _source: ["envelopeTo.address"],
      size: 0,
      aggs: {
        address: {
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
      size: 0,
      query: {
        bool: {
          must: { match: { read: false } }
        }
      },
      aggs: {
        address: {
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
      size: 0,
      query: { term: { "envelopeTo.address": `sent.by.me@${domainName}` } },
      aggs: {
        address: {
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

    const [allAccounts, unreadAccounts, sentAccounts] = r.responses.map(
      (e) => e.aggregations.address.buckets
    );

    let sentAccountIndex;

    allAccounts.forEach((e, i) => {
      if (e.key === `sent.by.me@${domainName}`) sentAccountIndex = i;
      const foundFromUnreadAccounts = unreadAccounts.find((f) => {
        if (!f.unread_doc_count) f.unread_doc_count = f.doc_count;
        return e.key === f.key;
      });
      e.unread_doc_count = foundFromUnreadAccounts?.doc_count || 0;
    });

    if (sentAccountIndex !== undefined) allAccounts.splice(sentAccountIndex, 1);

    return { new: unreadAccounts, all: allAccounts, sent: sentAccounts };
  });
};

db.markRead = (id) => {
  return db.request(`_update/${id}`, "POST", {
    script: "ctx._source.read = true"
  });
};

db.searchMail = (field, regex) => {
  return db.request("_search", "POST", {
    query: {
      query_string: {
        query: `${field}: ${regex}`
      }
    }
  });
};

db.deleteMail = (id) => {
  return db.request(`_doc/${id}`, "DELETE");
};

module.exports = db;
