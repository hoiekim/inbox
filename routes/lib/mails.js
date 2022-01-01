const Elastic = require("./components/elastic");
const uuid = require("uuid");
const fs = require("fs");
const sgMail = require("@sendgrid/mail");
const { htmlToText } = require("html-to-text");

sgMail.setApiKey(process.env.SENDGRID_KEY);

const domainName = process.env.DOMAIN || "mydomain";

const ELASTIC_HOST = process.env.ELASTIC_HOST || "http://elastic:9200";
const ELASTIC_USERNAME = process.env.ELASTIC_USERNAME || "";
const ELASTIC_PASSWORD = process.env.ELASTIC_PASSWORD || "";
const ELASTIC_INDEX = process.env.ELASTIC_INDEX_MAILS || "mails";

const Mail = new Elastic(
  ELASTIC_HOST,
  ELASTIC_USERNAME,
  ELASTIC_PASSWORD,
  ELASTIC_INDEX
);

const addressParser = (str) => {
  if (!str) return null;

  const result = str
    .split(",")
    .map((e) => e.replace(/ /g, ""))
    .filter((str) => {
      return typeof str === "string" && str.split("@").length === 2;
    })
    .map((e) => {
      return { email: e };
    });

  if (!result.length) return null;

  return result;
};

Mail.sendMail = async (mailData, files) => {
  if (!domainName) {
    throw new Error("You need to set your domainName name in the env data");
  }

  const { username, name, sender, to, cc, bcc, subject, html, inReplyTo } =
    mailData;
  const text = htmlToText(html);

  let attachments, attachmentsToSave;
  if (Array.isArray(files)) {
    attachments = [];
    attachmentsToSave = [];

    files.forEach((e) => {
      const id = genAttachmentId();
      const content = e.data;
      fs.writeFile(`./attachments/${id}`, Buffer.from(content), (err) => {
        if (err) throw new Error(err);
      });

      attachments.push({
        filename: e.name,
        content: e.data.toString("base64"),
        type: e.type,
        disposition: "attachment"
      });

      attachmentsToSave.push({
        content: { data: id },
        filename: e.name
      });
    });
  } else if (files?.name) {
    const id = genAttachmentId();
    const content = files.data;
    fs.writeFile(`./attachments/${id}`, Buffer.from(content), (err) => {
      if (err) throw new Error(err);
    });

    attachments = [
      {
        filename: files.name,
        content: files.data.toString("base64"),
        type: files.type,
        disposition: "attachment"
      }
    ];

    attachmentsToSave = [
      {
        content: { data: id },
        filename: files.name
      }
    ];
  }

  const email =
    username === "admin"
      ? `${sender}@${domainName}`
      : `${sender}@${username}.${domainName}`;

  const from = { name, email };

  const messageToSend = {
    from,
    subject,
    text,
    html
  };

  if (to) messageToSend.to = addressParser(to);
  if (cc) messageToSend.cc = addressParser(cc);
  if (bcc) messageToSend.bcc = addressParser(bcc);
  if (attachments) messageToSend.attachments = attachments;
  if (inReplyTo) messageToSend.headers = { inReplyTo };

  return sgMail
    .send(messageToSend)
    .then((r) => {
      console.info("Sendgrid email sending request succeed");

      const toDomain = messageToSend.to.map((e) => {
        const splitString = e.email.split("@")[1].split(".");
        const length = splitString.length;
        return splitString[length - 2] + "." + splitString[length - 1];
      });

      if (!toDomain.find((e) => e === domainName)) {
        const messageToSave = {
          ...messageToSend,
          date: new Date().toISOString(),
          attachments: attachmentsToSave || [],
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
        };

        return Mail.saveMail(messageToSave);
      } else return r;
    })
    .then((r) => true)
    .catch((error) => {
      throw new Error(error);
    });
};

const genAttachmentId = () => {
  const id = uuid.v4();
  if (fs.existsSync(`./attachments/${id}`)) {
    console.warn("Duplicate uuid is found");
    console.group();
    console.log(`Duplicated path: ./attachments/${id}`);
    console.log("Isn't attachments storage directory too full?");
    console.groupEnd();
    return genAttachmentId();
  } else return id;
};

Mail.saveMail = (body) => {
  body.attachments.forEach((e) => {
    const id = genAttachmentId();
    const content = e.content.data || e.content;
    fs.writeFile(`./attachments/${id}`, Buffer.from(content), (err) => {
      if (err) throw new Error(err);
    });
    e.content = { data: id };
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
    _source: ["envelopeTo", "html", "attachments", "messageId"],
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

Mail.getAccounts = (username) => {
  const fullDomain =
    username === "admin" ? domainName : `${username}.${domainName}`;
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
              query: `*@${fullDomain}`
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
                query: `*@${fullDomain}`
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
          query: `*@${fullDomain}`
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
      (e) => e.aggregations?.address.buckets || []
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
    doc: { read: true }
  });
};

Mail.searchMail = (value, username, options) => {
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

  const fullDomain =
    username === "admin" ? domainName : `${username}.${domainName}`;

  return Mail.request("_search", "POST", {
    _source: ["read", "date", "from", "to", "subject"],
    query: {
      bool: {
        must: [
          {
            query_string: {
              fields,
              query: value
            }
          },
          {
            query_string: {
              default_field: "envelopeTo.address",
              query: `*@${fullDomain}`
            }
          }
        ]
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

Mail.deleteMail = async (id) => {
  return Mail.request(`_doc/${id}`, "DELETE");
};

Mail.validateMailAddress = (data, domainName) => {
  if (!Array.isArray(data.envelopeTo)) data.envelopeTo = [data.envelopeTo];
  let isAddressCorrect = !!data.envelopeTo.find((e) => {
    const parsedAddress = e.address?.split("@");
    return parsedAddress[parsedAddress.length - 1].includes(domainName);
  });
  return isAddressCorrect;
};

module.exports = Mail;
