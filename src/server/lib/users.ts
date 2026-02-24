import bcrypt from "bcryptjs";
import crypto from "crypto";
import { User, SignedUser } from "common";
import { searchUser as pgSearchUser } from "./postgres/repositories/users";
import { usersTable, USER_ID, TOKEN, EXPIRY } from "./postgres/models";

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
  const pgUser = await pgSearchUser({
    user_id: user.id,
    username: user.username,
    email: user.email
  });

  if (!pgUser) return undefined;

  return new User({
    id: pgUser.user_id,
    username: pgUser.username,
    email: pgUser.email ?? undefined,
    password: pgUser.password
  });
};

export const getUsers = async (users: Partial<User>[]): Promise<User[]> => {
  const results: User[] = [];

  for (const user of users) {
    const found = await getUser(user);
    if (found) results.push(found);
  }

  return results;
};

export const getActiveUsers = async (
  users: Partial<User>[]
): Promise<SignedUser[]> => {
  // For simplicity, just return signed users from the list
  // In the PG version, we don't track "active" sessions the same way
  const results: SignedUser[] = [];

  for (const user of users) {
    const found = await getUser(user);
    const signed = found?.getSigned();
    if (signed) results.push(signed);
  }

  return results;
};

const deleteUser = async (id: string): Promise<boolean> => {
  try {
    return await usersTable.hardDelete(id);
  } catch (error) {
    console.error("Failed to delete user:", error);
    return false;
  }
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
  const token = crypto.randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + TOKEN_DURATION).toISOString();

  const existing = await getUser({ email });
  if (existing?.id) {
    await usersTable.update(existing.id, { [TOKEN]: token, [EXPIRY]: expiry });
    return { id: existing.id, username: existing.username, token };
  }

  const userId = crypto.randomUUID();
  await usersTable.insert({
    [USER_ID]: userId,
    username: `user_${userId.slice(0, 8)}`,
    email,
    token,
    expiry
  });

  return { id: userId, token };
};

export const isValidEmail = (email: string) => {
  const values = email.split("@");
  if (values.length !== 2) return false;
  const [local, domain] = values;
  // Local part: allow letters, digits, dots, underscores, hyphens, plus (case insensitive)
  const localValid = /^[a-zA-Z0-9._%+-]+$/.test(local);
  // Domain: allow letters, digits, dots, hyphens (case insensitive), must have at least one dot
  const domainValid = /^[a-zA-Z0-9.-]+$/.test(domain) && domain.includes(".");
  return localValid && domainValid;
};

export const startTimer = (userId: string) => {
  expiryTimer[userId] = setTimeout(async () => {
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
  const { email, password, token } = userInfo;
  let { username } = userInfo;
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

  await usersTable.update(id, {
    password: await encryptPassword(password),
    username,
    token: null,
    expiry: null
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
