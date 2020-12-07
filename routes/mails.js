const fs = require("fs");
const db = require("../lib/db");

const obj = {};

obj.saveMail = async (req, res) => {
  console.log(
    "Recieved POST request to /api/mails",
    req.ip,
    "at",
    new Date(Date.now())
  );
  await db.saveMail({ ...req.body, read: false, label: undefined });
  const envelopeTo = req.body.envelopeTo[0].address;
};

obj.getAccounts = async (req, res) => {
  console.log(
    "Recieved GET request to /api/accounts",
    req.ip,
    "at",
    new Date(Date.now())
  );
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  const accounts = await db.getAccounts();
  res.json(accounts);
};

obj.getUnreadNo = async (req, res) => {
  console.log(
    "Recieved GET request to /api/unreadNo/:account",
    req.ip,
    "at",
    new Date(Date.now())
  );
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  const number = await db.getUnreadNo(req.params.account);
  res.json(number);
};

obj.markRead = async (req, res) => {
  console.log(
    "Recieved GET request to /api/markRead/:id",
    req.ip,
    "at",
    new Date(Date.now())
  );
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  const result = await db.markRead(req.params.id);
  res.json(result);
};

obj.getMails = async (req, res) => {
  console.log(
    "recieved GET request to /api/mails/:account",
    req.ip,
    "at",
    new Date(Date.now())
  );
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  const mails = await db.getMails(req.params.account);
  res.json(mails);
};

obj.deleteMail = async (req, res) => {
  console.log(
    "recieved DELETE request to /api/mails/:id",
    req.ip,
    "at",
    new Date(Date.now())
  );
  if (!req.session.admin) return res.json(new Error("Admin Login is required"));
  const result = db.deleteMail(req.params.id);
  res.json(result);
};

obj.sendMail = async (req, res) => {
  console.log(
    "recieved POST request to /api/send",
    req.ip,
    "at",
    new Date(Date.now())
  );
};

module.exports = obj;
