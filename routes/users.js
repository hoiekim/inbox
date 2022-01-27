const User = require("./lib/users");

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
      req.session.user = { ...userInfo };
      if (userInfo.username === "admin") userInfo.username === null;
      res.status(200).json(userInfo);
    } else {
      res.status(401).json(false);
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

router.sendToken = async (req, res) => {
  console.info(
    "Received POST request to /user/send-token",
    req.ip,
    "at",
    new Date()
  );
  try {
    const result = await User.sendToken(req.body.email);
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
    await User.setUserInfo(req.body);
    const updatedUserInfo = {
      email: req.body.email,
      username: req.body.username
    };
    req.session.user = updatedUserInfo;
    res.status(200).json(updatedUserInfo);
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to set user information"));
  }
};

export default router;
