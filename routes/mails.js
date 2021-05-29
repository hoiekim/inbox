const fs = require("fs");
const db = require("../lib/db");
const mail = require("../lib/mail");

const obj = {};

obj.getAttachment = async (req, res) => {
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  try {
    const attachment = await db.getAttachment(req.params.id);
    res.status(200).send(attachment);
  } catch (err) {
    console.log(err);
    res.status(500).json(new Error("Failed to get attachment data"));
  }
};

obj.getAccounts = async (req, res) => {
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  const accounts = await db.getAccounts();
  res.status(200).json(accounts);
};

obj.getUnreadNo = async (req, res) => {
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  const number = await db.getUnreadNo(req.params.account);
  res.status(200).json(number);
};

obj.markRead = async (req, res) => {
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  const result = await db.markRead(req.params.id);
  res.status(200).json(result);
};

obj.getMails = async (req, res) => {
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  const mails = await db.getMails(req.params.account);
  res.status(200).json(mails);
};

obj.getMailContent = async (req, res) => {
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  const mail = await db.getMailContent(req.params.id);
  res.status(200).json(mail);
};

obj.deleteMail = async (req, res) => {
  console.log(
    "recieved DELETE request to delete mail",
    req.ip,
    "at",
    new Date(Date.now())
  );
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  const result = await db.deleteMail(req.params.id);
  res.status(200).json(result);
};

obj.sendMail = async (req, res) => {
  console.log(
    "recieved POST request to send mail",
    req.ip,
    "at",
    new Date(Date.now())
  );
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  const result = await mail.sendMail(req.body, req.files?.attachments);
  res.status(200).json(result);
};

module.exports = obj;
