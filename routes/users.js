require("dotenv").config();

const users = {};

users.admin = (req, res) => {
  console.log(
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
  console.log(
    "Recieved GET request to /admin",
    req.ip,
    "at",
    new Date(Date.now())
  );
  res.status(200).json(req.session.adim === "admin");
};

users.logout = (req, res) => {
  console.log(
    "Recieved DELETE request to /admin",
    req.ip,
    "at",
    new Date(Date.now())
  );
  req.session.admin = "";
  res.status(200).json("Done");
};

module.exports = users;
