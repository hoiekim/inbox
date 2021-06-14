const sgMail = require("@sendgrid/mail");
const { htmlToText } = require("html-to-text");
const db = require("./db");

require("dotenv").config();

sgMail.setApiKey(process.env.SENDGRID_KEY);
const domainName = process.env.DOMAIN || "mydomainName";

const sendMail = async (mailData, files) => {
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
      return db.saveMail({
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

module.exports = { sendMail };
