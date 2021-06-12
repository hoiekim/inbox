require("dotenv").config();

const users = {};

users.admin = (req, res) => {
  console.info(
    "Recieved POST request to /admin",
    req.ip,
    "at",
    new Date(Date.now())
  );
  if (req.body.password === process.env.ADMIN_PW) {
    req.session.admin = "admin";
    res.status(200).json(true);
  } else {
    res.status(200).json(false);
  }
};

users.check = (req, res) => {
  console.info(
    "Recieved GET request to /admin",
    req.ip,
    "at",
    new Date(Date.now())
  );
  res.status(200).json(req.session.admin === "admin");
};

users.logout = (req, res) => {
  console.info(
    "Recieved DELETE request to /admin",
    req.ip,
    "at",
    new Date(Date.now())
  );
  req.session.admin = "";
  res.status(200).json(true);
};

module.exports = users;
