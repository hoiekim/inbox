const bcrypt = require("bcrypt");
const Elastic = require("./components/elastic");
const Mail = require("./mails");

const serviceHostname = process.env.SERVICE_HOSTNAME || "https://mydomain";

const ELASTIC_HOST = process.env.ELASTIC_HOST || "http://127.0.0.1:9200";
const ELASTIC_USERNAME = process.env.ELASTIC_USERNAME || "elastic";
const ELASTIC_PASSWORD = process.env.ELASTIC_PASSWORD || "";
const ELASTIC_INDEX = process.env.ELASTIC_INDEX_USERS || "users";

const User = new Elastic(
  ELASTIC_HOST,
  ELASTIC_USERNAME,
  ELASTIC_PASSWORD,
  ELASTIC_INDEX
);

User.getUser = (query) => {
  return User.request("_search", "POST", {
    query: {
      term: query
    }
  })
    .then((r) => r.hits?.hits)
    .then((r) => {
      return r && r[0] && { ...r[0]?._source, id: r[0]?._id };
    });
};

User.deleteUser = (id) => {
  return User.request(`_doc/${id}`, "DELETE");
};

const validate = (value) => /^[a-z0-9.-]+$/.test(value);

User.signIn = async (credentials) => {
  const { username, email, password } = credentials;
  const query = {};
  if (username) {
    query.username = username;
    if (!validate(username)) {
      console.log("Signin failed because username is invalid");
      return null;
    }
  } else if (email) {
    query.email = email;
    const values = email.split("@");
    const validation = !values.length || !values.find((e) => !validate(e));
    if (!validation) {
      console.log("Signin failed because email is invalid");
      return null;
    }
  } else {
    console.log("Signin failed because neither username or email is provided");
    return null;
  }

  const userInfo = await User.getUser(query);
  if (!userInfo) {
    console.log("Signin failed because user is not found.");
    return null;
  }

  const pwMatches = await bcrypt.compare(password, userInfo.password);
  if (!pwMatches) {
    console.log("Signin failed because password does not match.");
    return null;
  }

  return userInfo;
};

User.expiryTimer = {};

const getToken = () => Math.floor(Math.random() * 1000000000).toString(36);

User.signUp = async (email) => {
  const values = email.split("@");
  const validation = !values.find((e) => !validate(e));

  if (values.length !== 2 || !validation) {
    console.info("Signup failed because email is invalid.");
    return false;
  }

  const existingUserInfo = await User.getUser({ email });
  if (existingUserInfo) {
    console.info("Signup failed because email already exists.");
    return false;
  }

  const token = getToken();
  const duration = 1000 * 60 * 60;
  const expiry = Date.now() + duration;

  const { _id: id } = await User.request("_doc", "POST", {
    email,
    token,
    expiry
  });

  await Mail.sendMail({
    name: "Administrator",
    sender: "admin",
    to: email,
    subject: "Please set your password for Inbox",
    html: `
<h2 style="text-align: center;">Thanks for signing up with Inbox!</h2>
<p style="text-align: center;">
  You have requested sign-up confirmation email for Inbox.
  <br/>
  Please click the button below to complete signing up.
</p>
<a
  href="${serviceHostname}/sign-up/${id}?t=${token}"
  target="inbox-confirm"
  style="display: flex; align-items: center; justify-content: center; margin: 2rem auto; background-color: #3291FF; color: white; border: none; height: 40px; width: 400px; font-size: 20px;"
>Confirm Sign Up</a>
<p style="text-align: center;">
  * This email expires in 1 hour.
  <br/>  
  * You should not share this email with other people.
</p>
`
  });

  User.expiryTimer.id = setTimeout(async () => {
    const updatedUserInfo = await User.getUser({ _id: id });
    if (updatedUserInfo.expiry < new Date()) {
      await User.deleteUser(id);
      console.info("Deleted user with expired token.", `User Email: ${email}`);
    }
  }, duration);

  return true;
};

User.setUserInfo = async (userInfo) => {
  if (!userInfo.id) {
    throw new Error("Setting userInfo failed because id is not specified.");
  }

  const { id, password, token, username } = userInfo;

  const findUserInfoById = await User.getUser({ _id: id });
  if (!findUserInfoById) {
    throw new Error("Setting userInfo failed because user data is not found.");
  }
  if (findUserInfoById.token !== token) {
    throw new Error(
      "Setting userInfo failed because user token does not match."
    );
  }
  if (findUserInfoById.expiry < Date.now()) {
    await User.deleteUser(id);
    throw new Error("Setting userInfo failed because user token is expired.");
  }

  const expiryTimer = User.expiryTimer[userInfo.id];
  if (expiryTimer) clearTimeout(expiryTimer);

  const findUserInfoByUsername = await User.getUser({ username });
  if (findUserInfoByUsername) {
    throw new Error("Setting userInfo failed because username already exists.");
  }

  const encryptedPassword = await bcrypt.hash(password, 10);

  return User.request(`_update/${id}`, "POST", {
    doc: {
      password: encryptedPassword,
      username,
      token: null,
      expiry: 0
    }
  });
};

module.exports = User;
