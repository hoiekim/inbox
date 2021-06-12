const sgMail = require("@sendgrid/mail");
const { htmlToText } = require("html-to-text");
require("dotenv").config();

sgMail.setApiKey(process.env.SENDGRID_KEY);
const domain = process.env.DOMAIN || "mydomain";

const sendMail = async (mailData, files) => {
  if (!domain) {
    throw new Error("You need to set your domain name in the env data");
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

  const from = { name, email: `${sender}@${domain}` };

  const msg = {
    from,
    to: [{ email: to }, { email: `sent.by.me@${domain}` }],
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
      console.info("Sendgrid email sending request succeed", r);
      return true;
    })
    .catch((error) => {
      throw new Error(error);
    });
};

module.exports = { sendMail };
