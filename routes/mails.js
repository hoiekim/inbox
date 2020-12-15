const fs = require("fs");
const db = require("../lib/db");
const mail = require("../lib/mail");

const obj = {};

obj.saveMail = async (req, res) => {
  console.log(
    "Recieved POST request to save mail",
    req.ip,
    "at",
    new Date(Date.now())
  );
  await db.saveMail({ ...req.body, read: false, label: undefined });
  const envelopeTo = req.body.envelopeTo[0].address;
};

obj.getAttachment = async (req, res) => {
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  try {
    const attachment = await db.getAttachment(req.params.id);
    res.send(attachment);
  } catch (err) {
    console.log(err);
    res.json(new Error("Failed to get attachment data"));
  }
};

obj.getAccounts = async (req, res) => {
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  const accounts = await db.getAccounts();
  res.json(accounts);
};

obj.getUnreadNo = async (req, res) => {
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  const number = await db.getUnreadNo(req.params.account);
  res.json(number);
};

obj.markRead = async (req, res) => {
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  const result = await db.markRead(req.params.id);
  res.json(result);
};

obj.getMails = async (req, res) => {
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  const mails = await db.getMails(req.params.account);
  res.json(mails);
};

obj.getMailContent = async (req, res) => {
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  const mail = await db.getMailContent(req.params.id);
  res.json(mail);
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
  res.json(result);
};

obj.sendMail = async (req, res) => {
  console.log(
    "recieved POST request to send mail",
    req.ip,
    "at",
    new Date(Date.now())
  );
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  const result = await mail.sendMail(req.body, req.files.attachments);
  res.json(result);
};

module.exports = obj;
