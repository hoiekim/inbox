const nodemailer = require("nodemailer");

const sendMail = ({
  name,
  sender,
  to,
  cc,
  bcc,
  subject,
  attachments,
  text,
  html,
}) => {
  const transporter = nodemailer.createTransport({
    sendmail: true,
    newline: "unix",
    path: "/usr/sbin/sendmail",
  });
  attachments.forEach((e) => {
    e.content = Buffer.from(e.content);
  });
  const info = new Promise((res, rej) => {
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
  return info;
};

module.exports = { sendMail };
