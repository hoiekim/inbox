const db = require("../lib/db");
const mail = require("../lib/mail");

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

obj.getUnreadNo = async (req, res) => {
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  try {
    const number = await db.getUnreadNo(req.params.account);
    res.status(200).json(number);
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to get unread emails data"));
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
    const mails = await db.getMails(req.params.account);
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
  console.log(
    "recieved DELETE request to delete mail",
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
  console.log(
    "recieved POST request to send mail",
    req.ip,
    "at",
    new Date(Date.now())
  );
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  try {
    const result = await mail.sendMail(req.body, req.files?.attachments);
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to request to send email"));
  }
};

module.exports = obj;
