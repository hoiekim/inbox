const nodemailer = require("nodemailer");
const { htmlToText } = require("html-to-text");

const sendMail = async (mailData, files) => {
  const { name, sender, to, cc, bcc, subject, html } = mailData;
  const text = htmlToText(html);

  let attachments;
  if (Array.isArray(files)) {
    attachments = files.map((e) => {
      return { filename: e.name, content: e.data };
    });
  } else {
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
        from: `"${name}" <${sender}@hoie.kim>`,
        to,
        cc,
        bcc,
        subject,
        attachments,
        text,
        html,
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
