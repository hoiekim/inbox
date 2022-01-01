const bcrypt = require("bcrypt");
const Elastic = require("./components/elastic");
const Mail = require("./mails");

const serviceHostname = process.env.APP_DOMAIN || "mydomain";

const ELASTIC_HOST = process.env.ELASTIC_HOST || "http://elastic:9200";
const ELASTIC_USERNAME = process.env.ELASTIC_USERNAME || "";
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

  if (username === "admin") {
    if (password === process.env.ADMIN_PW) return credentials;
    else return null;
  }

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

  delete userInfo.password;
  return userInfo;
};

User.expiryTimer = {};

User.sendToken = async (email) => {
  const values = email.split("@");
  const validation = !values.find((e) => !validate(e));

  if (values.length !== 2 || !validation) {
    console.info("Signup failed because email is invalid.");
    return false;
  }

  const token = Math.floor(Math.random() * 1000000000).toString(36);
  const duration = 1000 * 60 * 60;
  const expiry = Date.now() + duration;

  let id, username;

  const existingUserInfo = await User.getUser({ email });
  if (existingUserInfo) {
    id = existingUserInfo.id;
    username = existingUserInfo.username;
  }

  if (!id) {
    id = await User.request("_doc", "POST", {
      email,
      token,
      expiry
    })._id;
  } else {
    await User.request(`_update/${id}`, "POST", {
      doc: { token }
    });
  }

  let href = `https://${serviceHostname}/set-info/${email}?t=${token}`;
  if (username) href += `&u=${username}`;

  await Mail.sendMail({
    username: "admin",
    name: "Administrator",
    sender: "admin",
    to: email,
    subject: "Please set your password for Inbox",
    html: `
<h2 style="text-align: center;">Thanks for signing up with Inbox!</h2>
<p style="text-align: center;">
  You have requested membership confirmation email for Inbox.
  <br/>
  Please click the button below to complete setting user information.
</p>
<a
  href="${href}"
  target="inbox-confirm"
  style="display: flex; align-items: center; justify-content: center; margin: 2rem auto; padding: 5px; background-color: #3291FF; color: white; border: none; height: 40px; width: 400px; font-size: 20px;"
>Confirm Sign Up</a>
<p style="text-align: center;">
  * This email expires in 1 hour.
  <br/>  
  * You should not share this email with other people.
  <br/>  
  * Ignore this email if you have not requested it.
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
  let { email, password, token, username } = userInfo;
  if (!email || !username || !password) {
    throw new Error("Setting userInfo failed because email is not specified.");
  }

  const findUserInfoByEmail = await User.getUser({ email });
  if (!findUserInfoByEmail) {
    throw new Error("Setting userInfo failed because user data is not found.");
  }

  const { id } = findUserInfoByEmail;

  if (findUserInfoByEmail.token !== token) {
    throw new Error(
      "Setting userInfo failed because user token does not match."
    );
  }

  if (!findUserInfoByEmail.username) {
    if (findUserInfoByEmail.expiry < Date.now()) {
      await User.deleteUser(id);
      throw new Error("Setting userInfo failed because user token is expired.");
    }

    const expiryTimer = User.expiryTimer[id];
    if (expiryTimer) clearTimeout(expiryTimer);

    const findUserInfoByUsername = await User.getUser({ username });
    if (findUserInfoByUsername) {
      throw new Error(
        "Setting userInfo failed because username already exists."
      );
    }
  } else {
    username = findUserInfoByEmail.username;
  }

  const encryptedPassword = await bcrypt.hash(password, 10);

  await User.request(`_update/${id}`, "POST", {
    doc: {
      password: encryptedPassword,
      username,
      token: null,
      expiry: 0
    }
  });

  return true;
};

module.exports = User;
