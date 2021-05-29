const nodeMailin = require("node-mailin");
const sgMail = require("@sendgrid/mail");
const db = require("../lib/db");
const { htmlToText } = require("html-to-text");
require("dotenv").config();

sgMail.setApiKey(process.env.SENDGRID_KEY);
const domain = process.env.DOMAIN || "";

nodeMailin.start({
  port: 25,
  logLevel: "info",
});

nodeMailin.on("message", async (connection, data, content) => {
  console.log(
    "Reacieved an email",
    `From: ${data.envelopeFrom}`,
    `To: ${data.evelopeTo}`,
    new Date(Date.now())
  );
  await db.saveMail({ ...data, read: false, label: undefined });
});

const sendMail = async (mailData, files) => {
  if (!domain) {
    throw new Error("You need to set your domain name in the env data");
  }

  const { name, sender, to, cc, bcc, subject, html, inReplyTo } = mailData;
  const text = htmlToText(html);

  let attachments;
  if (Array.isArray(files)) {
    attachments = files.map((e) => {
      return { filename: e.name, content: e.data };
    });
  } else if (files?.name) {
    attachments = [{ filename: files.name, content: files.data }];
  }

  const msg = {
    from: `"${name}" <${sender}@${domain}>`,
    to,
    cc,
    bcc,
    subject,
    attachments,
    text,
    html,
    inReplyTo,
  };

  return sgMail
    .send(msg)
    .then(() => {
      console.log("Email sent");
      return "done";
    })
    .catch((error) => {
      console.error(error);
    });
};

module.exports = { sendMail };
