const Mail = require("./lib/mails");

const domainName = process.env.DOMAIN || "mydomain";

const mailsRouter = {};

mailsRouter.getAttachment = async (req, res) => {
  console.info("Received GET request to attachment", req.ip, "at", new Date());
  if (!req.session.user) return res.json(new Error("Login is required"));
  try {
    const attachment = await Mail.getAttachment(req.params.id);
    res.status(200).send(attachment);
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to get attachment data"));
  }
};

mailsRouter.getAccounts = async (req, res) => {
  console.info("Received GET request to accounts", req.ip, "at", new Date());
  try {
    const { user } = req.session;
    if (!user) return res.status(401).json(new Error("Not allowed"));
    const accounts = await Mail.getAccounts(user.username);
    res.status(200).json(accounts);
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to get accounts data"));
  }
};

mailsRouter.markRead = async (req, res) => {
  console.info("Received GET request to mark read", req.ip, "at", new Date());
  if (!req.session.user) return res.json(new Error("Login is required"));
  try {
    const mail = await Mail.getMailBody(req.params.id);
    const { username } = req.session.user;
    const fullDomain =
      username === "admin" ? domainName : `${username}.${domainName}`;
    const valid = Mail.validateMailAddress(mail, fullDomain);
    if (valid) {
      const result = await Mail.markRead(req.params.id);
      res.status(200).json(result);
    } else {
      throw new Error("Wrong Request");
    }
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to request to mark as read"));
  }
};

mailsRouter.getMails = async (req, res) => {
  console.info("Received GET request to mails", req.ip, "at", new Date());
  if (!req.session.user) return res.json(new Error("Login is required"));

  try {
    const { username } = req.session.user;
    const usernameInAccount = req.params.account
      .split("@")[1]
      .split(`.${domainName}`)[0];
    if (username !== "admin" && username !== usernameInAccount) {
      throw new Error("Wrong request");
    }

    const mails = await Mail.getMails(req.params.account, req.query);
    res.status(200).json(mails);
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to get emails data"));
  }
};

mailsRouter.getMailBody = async (req, res) => {
  console.info("Received GET request to mail body", req.ip, "at", new Date());
  if (!req.session.user) return res.json(new Error("Login is required"));
  try {
    const mail = await Mail.getMailBody(req.params.id);
    const { username } = req.session.user;
    const valid = Mail.validateMailAddress(mail, `${username}.${domainName}`);
    if (username === "admin" || valid) res.status(200).json(mail);
    else throw new Error("Wrong Request");
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to get email content data"));
  }
};

mailsRouter.deleteMail = async (req, res) => {
  console.info(
    "Received DELETE request to delete mail",
    req.ip,
    "at",
    new Date()
  );
  if (!req.session.user) return res.json(new Error("Login is required"));
  try {
    const id = req.params.id;
    const data = await Mail.getMailBody(id);
    const { username } = req.session.user;
    const valid = Mail.validateMailAddress(data, `${username}.${domainName}`);
    if (username === "admin" || valid) {
      const result = await Mail.deleteMail(id);
      res.status(200).json(result);
    } else {
      throw new Error("Wrong Request");
    }
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to request to delete email"));
  }
};

mailsRouter.sendMail = async (req, res) => {
  console.info("Received POST request to send mail", req.ip, "at", new Date());
  if (!req.session.user) return res.json(new Error("Login is required"));
  try {
    const { username } = req.session.user;
    const result = await Mail.sendMail(
      { ...req.body, username },
      req.files?.attachments
    );
    if (result) res.status(200).json(result);
    else throw new Error("Sendgrid request failed");
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to request to send email"));
  }
};

mailsRouter.saveMail = async (connection, data) => {
  console.info("Received an email at", new Date());
  console.group();
  console.log("envelopeFrom:", JSON.stringify(data.envelopeFrom));
  console.log("envelopeTo:", JSON.stringify(data.envelopeTo));
  console.log("from:", data.from?.text);
  console.log("to:", data.to?.text);
  console.groupEnd();
  try {
    if (Mail.validateMailAddress(data, domainName)) {
      const result = await Mail.saveMail({
        ...data,
        read: false,
        label: undefined
      });
      console.info("Successfully saved an email");
      return result;
    } else {
      console.warn("Not saved because address is wrong");
    }
  } catch (err) {
    console.error(err);
  }
};

mailsRouter.savePostMail = async (req, res) => {
  const data = req.body;
  try {
    const result = mailsRouter.saveMail(null, data);
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to save email"));
  }
};

mailsRouter.searchMail = async (req, res) => {
  console.info("Received GET request to search mail", req.ip, "at", new Date());
  if (!req.session.user) return res.json(new Error("Login is required"));
  try {
    const value = decodeURIComponent(req.params.value);
    const result = await Mail.searchMail(
      value,
      req.session.user.username,
      req.query
    );
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to search email"));
  }
};

export default mailsRouter;
