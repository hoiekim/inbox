import { signIn, sendToken, setUserInfo } from "./lib/users";

const router: any = {};

router.signIn = async (req: any, res: any) => {
  console.info(
    "Received POST request to /user/sign-in",
    req.ip,
    "at",
    new Date()
  );
  try {
    const userInfo = await signIn(req.body);
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

router.signOut = (req: any, res: any) => {
  console.info("Received DELETE request to /user", req.ip, "at", new Date());
  req.session.user = null;
  res.status(200).json(true);
};

router.sendToken = async (req: any, res: any) => {
  console.info(
    "Received POST request to /user/send-token",
    req.ip,
    "at",
    new Date()
  );
  try {
    const result = await sendToken(req.body.email);
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json(new Error("Failed to sign up"));
  }
};

router.setUserInfo = async (req: any, res: any) => {
  console.info(
    "Received POST request to /user/set-info",
    req.ip,
    "at",
    new Date()
  );
  try {
    await setUserInfo(req.body);
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
