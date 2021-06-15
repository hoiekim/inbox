const Elastic = require("./components/elastic");
const uuid = require("uuid");
const fs = require("fs");
const sgMail = require("@sendgrid/mail");
const { htmlToText } = require("html-to-text");

require("dotenv").config();

sgMail.setApiKey(process.env.SENDGRID_KEY);

const domainName = process.env.DOMAIN || "mydomain";

const ELASTIC_HOST = process.env.ELASTIC_HOST || "http://127.0.0.1:9200";
const ELASTIC_USERNAME = process.env.ELASTIC_USERNAME || "elastic";
const ELASTIC_PASSWORD = process.env.ELASTIC_PASSWORD || "";
const ELASTIC_INDEX = process.env.ELASTIC_INDEX || "mails";

const Mail = new Elastic(
  ELASTIC_HOST,
  ELASTIC_USERNAME,
  ELASTIC_PASSWORD,
  ELASTIC_INDEX
);

Mail.sendMail = async (mailData, files) => {
  if (!domainName) {
    throw new Error("You need to set your domainName name in the env data");
  }

  const { name, sender, to, cc, bcc, subject, html, inReplyTo } = mailData;
  const text = htmlToText(html);

  let attachments;
  if (Array.isArray(files)) {
    attachments = files.map((e) => {
      return {
        filename: e.name,
        content: e.data.toString("base64"),
        type: e.type,
        disposition: "attachment"
      };
    });
  } else if (files?.name) {
    attachments = [
      {
        filename: files.name,
        content: files.data.toString("base64"),
        type: files.type,
        disposition: "attachment"
      }
    ];
  }

  const from = { name, email: `${sender}@${domainName}` };

  const msg = {
    from,
    to: [{ email: to }],
    replyTo: from,
    subject,
    text,
    html
  };

  if (Array.isArray(cc)) {
    msg.cc = cc;
  } else if (typeof cc === "string" && cc.includes("@")) {
    msg.cc = { email: cc };
  }
  if (Array.isArray(bcc)) {
    msg.bcc = bcc;
  } else if (typeof bcc === "string" && bcc.includes("@")) {
    msg.bcc = { email: bcc };
  }
  if (attachments) msg.attachments = attachments;
  if (inReplyTo) msg.headers = { inReplyTo };

  return sgMail
    .send(msg)
    .then((r) => {
      console.info("Sendgrid email sending request succeed");
      console.warn(r);
      return Mail.saveMail({
        ...msg,
        date: new Date().toISOString(),
        attachments: attachments || [],
        messageId: `<${r[0].headers["x-message-id"]}@${domainName}>`,
        from: {
          value: { name, address: from.email },
          text: `${name} <${from.email}>`
        },
        to: { value: { address: to }, text: to },
        cc: { value: { address: cc }, text: cc },
        bcc: { value: { address: bcc }, text: bcc },
        envelopeFrom: {
          name,
          address: from.email
        },
        envelopeTo: { address: to },
        replyTo: { value: [{ name, address: from.email }] },
        read: true
      });
    })
    .then((r) => true)
    .catch((error) => {
      throw new Error(error);
    });
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

Mail.saveMail = (body) => {
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

  return Mail.request("_doc", "POST", body).then((r) => {
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

Mail.getAttachment = (id) => {
  return new Promise((res, rej) => {
    fs.readFile(`./attachments/${id}`, (err, data) => {
      if (err) rej(err);
      res(data);
    });
  });
};

Mail.getMails = (account, options) => {
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

  return Mail.request("_search", "POST", {
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

Mail.getMailBody = (id) => {
  return Mail.request("_search", "POST", {
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

Mail.getAccounts = () => {
  const accounts = Mail.request("_msearch", "POST", [
    // Query1: All accounts
    {},
    {
      size: 0,
      query: {
        bool: {
          must: {
            query_string: {
              default_field: "envelopeTo.address",
              query: `*@${domainName}`
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
                default_field: "envelopeTo.address",
                query: `*@${domainName}`
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
          query: `*@${domainName}`
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
      e.unread_doc_count =
        unreadAccounts.find((f) => e.key === f.key)?.doc_count || 0;
    });

    unreadAccounts.forEach((e) => {
      e.unread_doc_count = e.doc_count;
    });

    return { new: unreadAccounts, all: allAccounts, sent: sentAccounts };
  });
};

Mail.markRead = (id) => {
  return Mail.request(`_update/${id}`, "POST", {
    script: "ctx._source.read = true"
  });
};

Mail.searchMail = (value, options) => {
  const { field } = options;
  value = value.replace(/</g, "").replace(/>/g, "");

  const pattern = /([\!\*\+\-\=\<\>\&\|\(\)\[\]\{\}\^\~\?\:\\/"])/g;
  value = value.replace(pattern, "\\$1");

  value = value
    .split(" ")
    .map((e) => "*" + e + "*")
    .join(" ");

  const highlight = { fields: {} };
  const fields = field ? [field] : ["subject", "text"];
  fields.forEach((e, i) => {
    highlight.fields[e] = {};
    fields[i] += "^" + (fields.length - i);
  });

  return Mail.request("_search", "POST", {
    _source: ["read", "date", "from", "to", "subject"],
    query: {
      query_string: {
        fields,
        query: value
      }
    },
    highlight
  }).then((r) => {
    if (r.error) throw new Error(JSON.stringify(r.error));
    return r.hits.hits.map((e) => {
      return { ...e._source, id: e._id, highlight: e.highlight };
    });
  });
};

Mail.deleteMail = (id) => {
  return Mail.request(`_doc/${id}`, "DELETE");
};

module.exports = Mail;
