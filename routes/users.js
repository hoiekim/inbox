const users = {};

users.admin = (req, res) => {
  console.info("Received POST request to /admin", req.ip, "at", new Date());
  if (req.body.password === process.env.ADMIN_PW) {
    req.session.admin = "admin";
    res.status(200).json(true);
  } else {
    res.status(200).json(false);
  }
};

users.check = (req, res) => {
  console.info("Received GET request to /admin", req.ip, "at", new Date());
  res.status(200).json(req.session.admin === "admin");
};

users.logout = (req, res) => {
  console.info("Received DELETE request to /admin", req.ip, "at", new Date());
  req.session.admin = "";
  res.status(200).json(true);
};

module.exports = users;
