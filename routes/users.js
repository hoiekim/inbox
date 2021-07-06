const User = require("../lib/users");

const router = {};

router.signIn = async (req, res) => {
  console.info(
    "Received POST request to /user/sign-in",
    req.ip,
    "at",
    new Date()
  );
  try {
    const userInfo = await User.signIn(req.body);
    if (userInfo) {
      req.session.user = userInfo;
      res.status(200).json({ ...userInfo, password: null });
    } else {
      res.status(401).json(null);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to sign in"));
  }
};

router.check = (req, res) => {
  console.info("Received GET request to /user", req.ip, "at", new Date());
  res.status(200).json(req.session.user || null);
};

router.signOut = (req, res) => {
  console.info("Received DELETE request to /user", req.ip, "at", new Date());
  req.session.user = null;
  res.status(200).json(true);
};

router.signUp = async (req, res) => {
  console.info(
    "Received POST request to /user/sign-up",
    req.ip,
    "at",
    new Date()
  );
  try {
    const result = await User.signUp(req.body.email);
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to sign up"));
  }
};

router.setUserInfo = async (req, res) => {
  console.info(
    "Received POST request to /user/set-info",
    req.ip,
    "at",
    new Date()
  );
  try {
    const result = await User.setUserInfo(req.body);
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to set user information"));
  }
};

module.exports = router;
