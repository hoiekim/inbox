import Elastic from "./components/elastic";
import fs from "fs";
import sgMail from "@sendgrid/mail";
import { EmailData } from "@sendgrid/helpers/classes/email-address";
import { AttachmentData } from "@sendgrid/helpers/classes/attachment";
import { htmlToText } from "html-to-text";
import { FileArray, UploadedFile } from "express-fileupload";
const uuid = require("uuid");

sgMail.setApiKey(process.env.SENDGRID_KEY || "");

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

export default Mail;

const { request } = Mail;

const addressParser = (str: string) => {
  if (!str) return;

  const result = str
    .split(",")
    .map((e) => e.replace(/ /g, ""))
    .filter((str) => {
      return typeof str === "string" && str.split("@").length === 2;
    })
    .map((e) => {
      return { email: e };
    });

  if (!result.length) return;

  return result;
};

export interface MailToSend {
  username: string;
  name: string;
  sender: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  html: string;
  inReplyTo: string;
}

export const sendMail = async (mailData: MailToSend, files: FileArray) => {
  if (!domainName) {
    throw new Error("You need to set your domainName name in the env data");
  }

  const { username, name, sender, to, cc, bcc, subject, html, inReplyTo } =
    mailData;
  const text = htmlToText(html, {
    selectors: [{ selector: "img", format: "skip" }]
  });

  const attachments: AttachmentData[] = [];
  const attachmentsToSave: (AttachmentData | { content: { data: string } })[] =
    [];

  const parseFile = (e: UploadedFile) => {
    const id = genAttachmentId();
    const content = e.data;
    fs.writeFile(`./attachments/${id}`, Buffer.from(content), (err) => {
      if (err) throw err;
    });

    attachments.push({
      filename: e.name,
      content: e.data.toString("base64"),
      type: e.mimetype,
      disposition: "attachment"
    });

    attachmentsToSave.push({
      content: { data: id },
      filename: e.name
    });
  };

  if (Array.isArray(files)) files.forEach(parseFile);
  else if (files) parseFile(files as unknown as UploadedFile);

  const email =
    username === "admin"
      ? `${sender}@${domainName}`
      : `${sender}@${username}.${domainName}`;

  const from = { name, email };

  const messageToSend: sgMail.MailDataRequired = {
    from,
    subject,
    text,
    html,
    to: addressParser(to),
    cc: addressParser(cc),
    bcc: addressParser(bcc),
    attachments: attachments.length ? attachments : undefined,
    headers: inReplyTo ? { inReplyTo } : undefined
  };

  return sgMail
    .send(messageToSend)
    .then((r) => {
      console.info("Sendgrid email sending request succeed");

      const toData = messageToSend.to as EmailData[];
      const toDomain = toData.map((e: EmailData) => {
        let email: string;
        if (typeof e === "string") email = e;
        else email = e.email;
        const splitString = email.split("@")[1].split(".");
        const length = splitString.length;
        return splitString[length - 2] + "." + splitString[length - 1];
      });

      if (!toDomain.find((e: string) => e === domainName)) {
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

        return saveMail(messageToSave);
      } else return r;
    })
    .then((r) => true)
    .catch((error) => {
      throw new Error(error);
    });
};

const genAttachmentId = (): string => {
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

// TODO: Clarify variable types
export const saveMail = (body: any) => {
  body.attachments.forEach((e: any) => {
    const id = genAttachmentId();
    const content = e.content.data || e.content;
    fs.writeFile(`./attachments/${id}`, Buffer.from(content), (err) => {
      if (err) throw err;
    });
    e.content = { data: id };
  });

  delete body.connection;
  delete body.envelopeFrom.args;
  delete body.envelopeTo.args;

  return request("_doc", "POST", body).then((r: any) => {
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

export const getAttachment = (id: string) => {
  return new Promise((res, rej) => {
    fs.readFile(`./attachments/${id}`, (err, data) => {
      if (err) rej(err);
      res(data);
    });
  });
};

export interface EmailAdressValue {
  address: string;
  name?: string;
}

export interface EmailAdress {
  value: EmailAdressValue | EmailAdressValue[];
  text: string;
}

export interface MailHeaderType {
  id: string;
  read: boolean;
  label: string;
  date: string;
  from: EmailAdress;
  to: EmailAdress;
  cc: EmailAdress;
  bcc: EmailAdress;
  subject: string;
  highlight?: {
    subject?: string[];
    text?: string[];
  };
}

export interface Attachment {
  content: {
    data: string;
  };
  contentType: string;
  filename: string;
}

export interface MailBodyType {
  id: string;
  html: string;
  attachments: Attachment[];
  messageId: string;
}

export interface MailType extends MailHeaderType, MailBodyType {}

export const getMails = (
  account: string,
  options: { sent: any; new: any; saved: any }
): Promise<MailHeaderType[]> => {
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
  } else if (options.saved) {
    query = {
      bool: {
        must: [
          { term: { [searchFiled]: account } },
          { term: { label: "saved" } }
        ]
      }
    };
  } else {
    query = {
      term: {
        [searchFiled]: account
      }
    };
  }

  return request("_search", "POST", {
    _source: ["read", "label", "date", "from", "to", "cc", "bcc", "subject"],
    query,
    sort: { date: "desc" },
    from: 0,
    size: 10000
  })
    .then((r: any) => {
      if (!r.hits) return [];
      return r.hits.hits;
    })
    .then((r: any) => {
      return r.map((e: any) => {
        return { ...e._source, id: e._id };
      });
    });
};

export const getMailBody = (id: string): Promise<MailBodyType> => {
  return request("_search", "POST", {
    _source: ["envelopeTo", "html", "attachments", "messageId"],
    query: {
      term: {
        _id: id
      }
    }
  })
    .then((r: any) => {
      if (!r.hits) return [];
      return r.hits.hits;
    })
    .then((r: any) => {
      return { ...r[0]._source, id: r[0]._id };
    });
};

export interface Account {
  key: string;
  doc_count: number;
  unread_doc_count: number;
  saved_doc_count: number;
  updated: Date;
}

export interface AccountsResponse {
  received: Account[];
  sent: Account[];
}

export const getAccounts = (username: string): Promise<AccountsResponse> => {
  const fullDomain =
    username === "admin" ? domainName : `${username}.${domainName}`;
  const accounts = request("_msearch", "POST", [
    // Query1: Accounts that have received mails
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
            size: 10000,
            order: { updated: "desc" }
          },
          aggs: {
            updated: { max: { field: "date" } },
            read: {
              terms: {
                field: "read",
                size: 10000
              }
            },
            label: {
              terms: {
                field: "label",
                size: 10000
              }
            }
          }
        }
      }
    },
    // Query2: Accounts that have sent mails
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

  return accounts.then((r: any) => {
    if (r.error) throw new Error(JSON.stringify(r.error));
    const [received, sent] = r.responses.map(
      (e: any) => e.aggregations?.address.buckets || []
    );

    received.forEach((e: any) => {
      e.unread_doc_count =
        e.read.buckets.find((f: any) => !f.key)?.doc_count || 0;
      delete e.read;
      e.saved_doc_count =
        e.label.buckets.find((f: any) => f.key === "saved")?.doc_count || 0;
      delete e.label;
      e.updated = new Date(e.updated.value);
    });

    return { received, sent };
  });
};

export const markRead = (id: string) => {
  return request(`_update/${id}`, "POST", {
    doc: { read: true }
  });
};

export const markSaved = (id: string, options: { unsave: any }) => {
  const { unsave } = options;
  const label = unsave ? "" : "saved";
  return request(`_update/${id}`, "POST", { doc: { label } });
};

export const searchMail = (
  value: string,
  username: string,
  options: { field: string }
) => {
  const { field } = options;
  value = value.replace(/</g, "").replace(/>/g, "");

  const pattern = /([\!\*\+\-\=\<\>\&\|\(\)\[\]\{\}\^\~\?\:\\/"])/g;
  value = value.replace(pattern, "\\$1");

  value = value
    .split(" ")
    .map((e) => "*" + e + "*")
    .join(" ");

  const highlight: any = { fields: {} };
  const fields = field ? [field] : ["subject", "text"];
  fields.forEach((e, i) => {
    highlight.fields[e] = {};
    fields[i] += "^" + (fields.length - i);
  });

  const fullDomain =
    username === "admin" ? domainName : `${username}.${domainName}`;

  return request("_search", "POST", {
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
  }).then((r: any) => {
    if (r.error) throw new Error(JSON.stringify(r.error));
    return r.hits.hits.map((e: any) => {
      return { ...e._source, id: e._id, highlight: e.highlight };
    });
  });
};

export const deleteMail = async (id: string) => request(`_doc/${id}`, "DELETE");

export const validateMailAddress = (data: any, domainName: string) => {
  if (!Array.isArray(data.envelopeTo)) data.envelopeTo = [data.envelopeTo];
  let isAddressCorrect = !!data.envelopeTo.find((e: any) => {
    const parsedAddress = e.address?.split("@");
    const domainNameInData = parsedAddress[parsedAddress.length - 1];
    return domainNameInData.toLowerCase().includes(domainName.toLowerCase());
  });
  return isAddressCorrect;
};
