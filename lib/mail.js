const nodemailer = require("nodemailer");
const { htmlToText } = require("html-to-text");
require("dotenv").config();

const domain = process.env.DOMAIN || "";

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

  const transporter = nodemailer.createTransport({
    sendmail: true,
    newline: "unix",
    path: "/usr/sbin/sendmail",
  });

  return new Promise((res, rej) => {
    transporter.sendMail(
      {
        from: `"${name}" <${sender}@${domain}>`,
        to,
        cc,
        bcc,
        subject,
        attachments,
        text,
        html,
        inReplyTo,
      },
      (err, info) => {
        console.log("info", info);
        if (err) rej(err);
        if (info) res(info);
      }
    );
  });
};

module.exports = { sendMail };
