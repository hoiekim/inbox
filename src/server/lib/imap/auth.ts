/**
 * IMAP authentication helpers (LOGIN and AUTHENTICATE PLAIN).
 *
 * These are free functions; they take session state as explicit parameters
 * and return { store, authenticated } updates rather than mutating session directly.
 */

import bcrypt from "bcryptjs";
import { Socket } from "net";
import { getUser } from "server";
import { logger } from "server";
import { isAuthRateLimited, recordAuthFailure, resetAuthFailures } from "../auth-rate-limit";
import { Store } from "./store";

// Dummy hash used to prevent username enumeration via timing attacks.
const DUMMY_HASH =
  "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

export interface AuthResult {
  store: Store;
  authenticated: true;
}

/**
 * Handle AUTHENTICATE PLAIN mechanism.
 *
 * Returns AuthResult on success. On failure, writes directly to the socket
 * and returns null.
 */
export async function handleAuthenticate(
  tag: string,
  mechanism: string,
  initialResponse: string | undefined,
  socket: Socket,
  write: (data: string) => boolean | undefined,
  setPendingSaslTag: (tag: string) => void,
  getCapabilities: () => string
): Promise<AuthResult | null> {
  if (mechanism !== "PLAIN") {
    write(`${tag} NO Only PLAIN authentication supported\r\n`);
    return null;
  }

  if (!initialResponse) {
    write(`+ \r\n`);
    setPendingSaslTag(tag);
    return null;
  }

  const ip = socket.remoteAddress ?? "unknown";

  if (isAuthRateLimited(ip)) {
    write(`${tag} NO [AUTHENTICATIONFAILED] Too many failed attempts\r\n`);
    socket.end();
    return null;
  }

  try {
    const decoded = Buffer.from(initialResponse, "base64").toString("utf8");
    const parts = decoded.split("\0");

    if (parts.length !== 3) {
      write(`${tag} BAD Invalid PLAIN response format\r\n`);
      return null;
    }

    const [, username, password] = parts;

    const inputUser = { username, password };
    const user = await getUser(inputUser);
    const signedUser = user?.getSigned();

    const pwMatches = await bcrypt.compare(
      password,
      user?.password ?? DUMMY_HASH
    );

    if (!password || !user || !signedUser || !pwMatches) {
      const limited = await recordAuthFailure(ip);
      if (limited) {
        write(`${tag} NO [AUTHENTICATIONFAILED] Too many failed attempts\r\n`);
        socket.end();
        return null;
      }
      write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials.\r\n`);
      return null;
    }

    resetAuthFailures(ip);
    write(
      `${tag} OK [CAPABILITY ${getCapabilities()}] AUTHENTICATE completed\r\n`
    );
    return { store: new Store(signedUser), authenticated: true };
  } catch (error) {
    logger.error("AUTHENTICATE error", { component: "imap" }, error);
    write(`${tag} BAD AUTHENTICATE failed\r\n`);
    return null;
  }
}

/**
 * Handle LOGIN command.
 *
 * Returns AuthResult on success; writes error responses and returns null otherwise.
 */
export async function handleLogin(
  tag: string,
  args: string[],
  socket: Socket,
  write: (data: string) => boolean | undefined,
  getCapabilities: () => string
): Promise<AuthResult | null> {
  if (args.length < 2) {
    write(`${tag} BAD LOGIN requires username and password\r\n`);
    return null;
  }

  const ip = socket.remoteAddress ?? "unknown";

  if (isAuthRateLimited(ip)) {
    write(`${tag} NO [AUTHENTICATIONFAILED] Too many failed attempts\r\n`);
    socket.end();
    return null;
  }

  const [username, password] = args;
  const cleanUsername = username.replace(/^"(.*)"$/, "$1");
  const cleanPassword = password.replace(/^"(.*)"$/, "$1");

  const inputUser = { username: cleanUsername, password: cleanPassword };
  const user = await getUser(inputUser);
  const signedUser = user?.getSigned();

  const pwMatches = await bcrypt.compare(
    cleanPassword,
    user?.password ?? DUMMY_HASH
  );

  if (!cleanPassword || !user || !signedUser || !pwMatches) {
    const limited = await recordAuthFailure(ip);
    if (limited) {
      write(`${tag} NO [AUTHENTICATIONFAILED] Too many failed attempts\r\n`);
      socket.end();
      return null;
    }
    write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials.\r\n`);
    return null;
  }

  resetAuthFailures(ip);
  write(`${tag} OK [CAPABILITY ${getCapabilities()}] LOGIN completed\r\n`);
  return { store: new Store(signedUser), authenticated: true };
}
