const db = require("../lib/db");
const mail = require("../lib/mail");

const domainName = process.env.DOMAIN || "mydomain";

const obj = {};

obj.getAttachment = async (req, res) => {
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  try {
    const attachment = await db.getAttachment(req.params.id);
    res.status(200).send(attachment);
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to get attachment data"));
  }
};

obj.getAccounts = async (req, res) => {
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  try {
    const accounts = await db.getAccounts();
    res.status(200).json(accounts);
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to get accounts data"));
  }
};

obj.markRead = async (req, res) => {
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  try {
    const result = await db.markRead(req.params.id);
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to request to mark as read"));
  }
};

obj.getMails = async (req, res) => {
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  try {
    const mails = await db.getMails(req.params.account, req.query);
    res.status(200).json(mails);
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to get emails data"));
  }
};

obj.getMailContent = async (req, res) => {
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  try {
    const mail = await db.getMailContent(req.params.id);
    res.status(200).json(mail);
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to get email content data"));
  }
};

obj.deleteMail = async (req, res) => {
  console.info(
    "received DELETE request to delete mail",
    req.ip,
    "at",
    new Date(Date.now())
  );
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  try {
    const result = await db.deleteMail(req.params.id);
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to request to delete email"));
  }
};

obj.sendMail = async (req, res) => {
  console.info(
    "received POST request to send mail",
    req.ip,
    "at",
    new Date(Date.now())
  );
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  try {
    const result = await mail.sendMail(req.body, req.files?.attachments);
    if (result === true) res.status(200).json(result);
    else throw new Error("Sendgrid request failed");
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to request to send email"));
  }
};

obj.saveMail = async (connection, data) => {
  console.info("Received an email at", new Date(Date.now()));
  console.group();
  console.log("envelopeFrom:", JSON.stringify(data.envelopeFrom));
  console.log("envelopeTo:", JSON.stringify(data.envelopeTo));
  console.log("from:", data.from?.text);
  console.log("to:", data.to?.text);
  console.groupEnd();
  try {
    let isAddressCorrect = !!data.envelopeTo.find((e) => {
      const parsedAddress = e.address.split("@");
      return parsedAddress[parsedAddress.length - 1] === domainName;
    });
    if (!isAddressCorrect) {
      isAddressCorrect = !!data.to.value.find((e) => {
        const parsedAddress = e.address.split("@");
        return parsedAddress[parsedAddress.length - 1] === domainName;
      });
    }
    if (isAddressCorrect) {
      await db.saveMail({ ...data, read: false, label: undefined });
      console.info("Successfully saved an email");
    } else {
      console.warn("Not saved because address is wrong");
    }
  } catch (err) {
    console.error(err);
  }
};

module.exports = obj;
