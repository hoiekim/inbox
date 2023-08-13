import { QueryDslQueryContainer } from "@elastic/elasticsearch/lib/api/types";
import bcrypt from "bcrypt";
import { User, SignedUser, callWithDelay } from "common";
import { elasticsearchClient, index } from "server";

const { APP_HOSTNAME } = process.env;

export const getSignedUser = (user?: User) => {
  if (!user) return;
  const { id, username, email, password } = user;
  if (!id || !username || !password || !email) return;
  return user as SignedUser;
};

export const getUser = async (
  user: Partial<User>
): Promise<User | undefined> => {
  const must: QueryDslQueryContainer[] = [];
  must.push({ term: { type: "user" } });

  Object.entries(user).forEach(([key, value]) => {
    if (key === "password") return;
    must.push({ term: { [`user.${key}`]: value } });
  });

  const response = await elasticsearchClient.search({
    query: { bool: { must } }
  });

  const foundUser = response.hits.hits[0]?._source?.user;
  return foundUser && new User(foundUser);
};

export const getUsers = async (users: Partial<User>[]): Promise<User[]> => {
  const userQueries = users.map((user) => {
    const must: QueryDslQueryContainer[] = [];
    Object.entries(user).forEach(([key, value]) => {
      if (key === "password") return;
      must.push({ term: { [`user.${key}`]: value } });
    });
    return { bool: { must } };
  });

  const response = await elasticsearchClient.search({
    query: {
      bool: {
        must: [{ term: { type: "user" } }, { bool: { should: userQueries } }]
      }
    }
  });

  return response.hits.hits
    .map(({ _source }) => {
      const foundUser = _source?.user;
      return foundUser && new User(foundUser);
    })
    .filter((u): u is User => !!u);
};

const deleteUser = (id: string) => {
  return elasticsearchClient.delete({ index, id });
};

export const expiryTimer: { [k: string]: NodeJS.Timeout } = {};

const TOKEN_DURATION = 1000 * 60 * 60;

export const createToken = async (
  email: string
): Promise<{
  id: string;
  token: string;
  username?: string;
}> => {
  const token = Math.floor(Math.random() * 1_000_000_000).toString(36);
  const expiry = new Date(Date.now() + TOKEN_DURATION).toISOString();

  const existing = await getUser({ email });
  if (existing?.id) {
    await elasticsearchClient.update({
      id: existing.id,
      doc: { user: { token } }
    });
    return { id: existing.id, username: existing.username, token };
  }

  const createResponse = await elasticsearchClient.index({
    document: {
      type: "user",
      user: { email, token, expiry },
      updated: new Date().toISOString()
    }
  });

  const { _id } = createResponse;

  await callWithDelay(() => {
    return elasticsearchClient.update({
      id: _id,
      doc: { user: { id: _id }, updated: new Date().toISOString() }
    });
  }, 1000);

  return { id: _id, token };
};

export const isValidEmail = (email: string) => {
  const values = email.split("@");
  if (values.length !== 2) return false;
  return !values.find((v) => !/^[a-z0-9.-]+$/.test(v));
};

export const startTimer = (userId: string) => {
  expiryTimer.id = setTimeout(async () => {
    const updatedUserInfo = await getUser({ id: userId });
    if (!updatedUserInfo) return;
    const { expiry } = updatedUserInfo;
    if (expiry === undefined) return;
    const expiryDate = expiry && new Date(expiry);
    if (expiryDate && expiryDate.getTime() < Date.now()) {
      await deleteUser(userId);
      console.info("Deleted user with expired token.", `User: ${userId}`);
    }
  }, TOKEN_DURATION);
};

export const encryptPassword = (password: string) => {
  const salt = 10;
  return bcrypt.hash(password, salt);
};

export const setUserInfo = async (
  userInfo: Partial<User>
): Promise<SignedUser> => {
  let { email, password, token, username } = userInfo;
  if (!email || !username || !password) {
    throw new Error(
      `Setting userInfo failed because input is invalid: ${userInfo}`
    );
  }

  const existingUser = await getUser({ email });
  if (!existingUser?.id) {
    throw new Error("`setUserInfo` failed because user doesn't exist.");
  }
  if (!existingUser.token || existingUser.token !== token) {
    throw new Error("`setUserInfo` failed because token doesn't match.");
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
      throw new Error("`setUserInfo` failed because username already exists.");
    }
  } else {
    username = existingUser.username;
  }

  await elasticsearchClient.update({
    index,
    id,
    doc: {
      password: await encryptPassword(password),
      username,
      token: null,
      expiry: null
    }
  });

  return new User({ id, email, username }).getSigned() as SignedUser;
};

export const createAuthenticationMail = (
  email: string,
  token: string,
  username?: string
) => {
  let href = `https://${APP_HOSTNAME}/set-info/${email}?t=${token}`;
  if (username) href += `&u=${username}`;

  return {
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
  };
};
