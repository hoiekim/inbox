const nodemailer = require("nodemailer");

const sendMail = async ({ name, sender, to, cc, subject, text, html }) => {
  const transporter = nodemailer.createTransport({
    sendmail: true,
    newline: "unix",
    path: "/usr/sbin/sendmail",
  });
  return await transporter.sendMail(
    {
      from: `"${name}" <${sender}@hoie.kim>`,
      to,
      cc,
      subject,
      text,
      html,
    },
    (err, info) => {
      console.log("info", info);
      if (err) throw err;
    }
  );
};

module.exports = { sendMail };

const input = {
  sender: "test",
  to: "test@hoie.kim",
  subject: "This is a test mail",
  text: "I hope this sends mail",
};

sendMail(input);
