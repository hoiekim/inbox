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
    // Query1: All accounts
    {},
    {
      size: 0,
      query: {
        bool: {
          must: {
            query_string: {
              default_field: "envelopeTo.address",
              query: "*@hoie.kim"
            }
          }
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
    // Query2: Accounts that have new mails
    {},
    {
      size: 0,
      query: {
        bool: {
          must: [
            {
              query_string: {
                default_field: "eveleopeTo.address",
                query: "*@hoie.kim"
              }
            },
            { term: { read: false } }
          ]
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
    // Query3: Accounts that have sent mails
    {},
    {
      size: 0,
      query: {
        query_string: {
          default_field: "from.value.address",
          query: "*@hoie.kim"
        }
      },
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

    allAccounts.forEach((e) => {
      e.unread_doc_count = unreadAccounts.find(
        (f) => e.key === f.key
      )?.doc_count;
    });

    unreadAccounts.forEach((e) => {
      e.unread_doc_count = e.doc_count;
    });

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
