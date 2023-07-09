import bcrypt from "bcrypt";
import Elastic from "./elastic";
import { User, sendMail } from "server";

const appHostname = process.env.APP_HOSTNAME || "mydomain";

const ELASTIC_HOST = process.env.ELASTIC_HOST || "http://elastic:9200";
const ELASTIC_USERNAME = process.env.ELASTIC_USERNAME || "";
const ELASTIC_PASSWORD = process.env.ELASTIC_PASSWORD || "";
const ELASTIC_INDEX = process.env.ELASTIC_INDEX_USERS || "users";

const UserClient = new Elastic(
  ELASTIC_HOST,
  ELASTIC_USERNAME,
  ELASTIC_PASSWORD,
  ELASTIC_INDEX
);

export default UserClient;

const { request } = UserClient;

export type MaskedUser = Omit<User, "password">;

export const maskUser = (user: User): MaskedUser => {
  const { id, email, username, token, expiry } = user;
  return { id, email, username, token, expiry };
};

export const getUser = (user: Partial<User>): Promise<User> => {
  type Term = Partial<Omit<User, "id"> & { _id: string }>;
  const term: Term = {};
  Object.entries(user).forEach(([key, value]) => {
    if (key === "id") term._id = value;
    else term[key as keyof Term] = value;
  });
  return request("_search", "POST", { query: { term } })
    .then((r) => r.hits?.hits)
    .then((r) => r && r[0] && { ...r[0]?._source, id: r[0]?._id });
};

export const deleteUser = (id: string) => {
  return request(`_doc/${id}`, "DELETE");
};

export const validate = (value: string) => /^[a-z0-9.-]+$/.test(value);

export const signIn = async (user: User): Promise<MaskedUser | null> => {
  const { username, email, password } = user;
  const query: Partial<User> = {};

  if (username === "admin") {
    if (password === process.env.ADMIN_PW) return user;
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

  const userInfo = await getUser(query);
  if (!userInfo) {
    console.log("Signin failed because user is not found.");
    return null;
  }

  const pwMatches = await bcrypt.compare(password, userInfo.password);
  if (!pwMatches) {
    console.log("Signin failed because password does not match.");
    return null;
  }

  return {
    id: userInfo.id,
    username: userInfo.username,
    email: userInfo.email
  };
};

export const expiryTimer: { [k: string]: NodeJS.Timeout } = {};

const TOKEN_DURATION = 1000 * 60 * 60;

const createToken = async (
  email: string
): Promise<{
  id: string;
  token: string;
  username?: string;
}> => {
  const token = Math.floor(Math.random() * 1000000000).toString(36);

  const expiry = Date.now() + TOKEN_DURATION;
  const existing = await getUser({ email });
  if (existing) {
    await request(`_update/${existing.id}`, "POST", {
      doc: { token }
    });
    return { id: existing.id, username: existing.username, token };
  }

  const createResponse = await request("_doc", "POST", {
    email,
    token,
    expiry
  });

  return { id: createResponse._id, token };
};

export const sendToken = async (email: string) => {
  const values = email.split("@");
  const validation = !values.find((e) => !validate(e));

  if (values.length !== 2 || !validation) {
    console.info("Signup failed because email is invalid.");
    return false;
  }

  const adminUser = await getUser({ username: "admin" });
  const createdUser = await createToken(email);
  const { id, username, token } = createdUser;

  let href = `https://${appHostname}/set-info/${email}?t=${token}`;
  if (username) href += `&u=${username}`;

  await sendMail(adminUser, {
    senderFullName: "Administrator",
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

  expiryTimer.id = setTimeout(async () => {
    const updatedUserInfo = await getUser({ id });
    const { expiry } = updatedUserInfo;
    if (expiry === undefined) return;
    const expiryDate = expiry && new Date(expiry);
    if (expiryDate && expiryDate.getTime() < Date.now()) {
      await deleteUser(id);
      console.info("Deleted user with expired token.", `User Email: ${email}`);
    }
  }, TOKEN_DURATION);

  return true;
};

export const setUserInfo = async (
  userInfo: Partial<User>
): Promise<MaskedUser> => {
  let { email, password, token, username } = userInfo;
  if (!email || !username || !password) {
    throw new Error(
      `Setting userInfo failed because input is invalid: ${userInfo}`
    );
  }

  const existingUser = await getUser({ email });
  if (!existingUser) {
    throw new Error("Setting userInfo failed because user data is not found.");
  }

  if (existingUser.token !== token) {
    throw new Error(
      "Setting userInfo failed because user token does not match."
    );
  }

  const { id } = existingUser;

  if (!existingUser.username) {
    const { expiry } = existingUser;
    const expiryDate = expiry && new Date(expiry);
    if (expiryDate && expiryDate.getTime() < Date.now()) {
      await deleteUser(id);
      throw new Error("Setting userInfo failed because user token is expired.");
    }

    const expiryTimeout = expiryTimer[id];
    if (expiryTimeout) clearTimeout(expiryTimeout);

    const findUserInfoByUsername = await getUser({ username });
    if (findUserInfoByUsername) {
      throw new Error(
        "Setting userInfo failed because username already exists."
      );
    }
  } else {
    username = existingUser.username;
  }

  const encryptedPassword = await bcrypt.hash(password, 10);

  await request(`_update/${id}`, "POST", {
    doc: {
      password: encryptedPassword,
      username,
      token: null,
      expiry: null
    }
  });

  return { id, email, username };
};
