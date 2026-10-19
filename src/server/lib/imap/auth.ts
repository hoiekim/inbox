/**
 * IMAP authentication helpers (LOGIN and AUTHENTICATE PLAIN).
 *
 * These are free functions; they take session state as explicit parameters
 * and return { store, authenticated } updates rather than mutating session directly.
 */

import { Socket } from "net";
import {
  getUser,
  logger,
  ADMIN_USERNAME,
  ADMIN_RO_USERNAME,
  remapReadOnlySession,
} from "server";
import { isAuthRateLimited, recordAuthFailure, resetAuthFailures } from "../auth-rate-limit";
import { verifyPassword } from "../verify-password";
import { Store } from "./store";
import { closeSocket } from "./close-socket";

export interface AuthResult {
  store: Store;
  authenticated: true;
  /** True when the caller authenticated with the read-only credential. */
  isReadOnly: boolean;
  /** Original username the caller sent, before any session-scope remap. */
  authenticatedAs: string;
}

/**
 * Resolves the effective SignedUser to attach to the store. For the reserved
 * read-only credential, this is admin's SignedUser with `isReadOnly` /
 * `authenticatedAs` set; for every other credential, it is the caller's own
 * signed user unchanged. Returns null when the read-only credential
 * authenticated but no admin row exists — treated by callers as a failed
 * authentication so the session is never issued without an effective identity.
 */
const resolveSessionUser = async (
  signedUser: ReturnType<NonNullable<Awaited<ReturnType<typeof getUser>>>["getSigned"]>
) => {
  if (!signedUser) return null;
  if (signedUser.username !== ADMIN_RO_USERNAME) {
    return { user: signedUser, isReadOnly: false };
  }
  const admin = await getUser({ username: ADMIN_USERNAME });
  const signedAdmin = admin?.getSigned();
  if (!signedAdmin) return null;
  return {
    user: remapReadOnlySession(signedAdmin, ADMIN_RO_USERNAME),
    isReadOnly: true,
  };
};

/** Shared failure reply: rate-limit exhaustion closes the socket, anything
 * else is a flat "Invalid credentials" that reveals nothing about which
 * check failed. */
const failAuth = async (
  tag: string,
  ip: string,
  socket: Socket,
  write: (data: string) => boolean | undefined
): Promise<null> => {
  const limited = await recordAuthFailure(ip);
  if (limited) {
    write(`${tag} NO [AUTHENTICATIONFAILED] Too many failed attempts\r\n`);
    closeSocket(socket);
    return null;
  }
  write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials.\r\n`);
  return null;
};

type ResolvedSessionUser = NonNullable<Awaited<ReturnType<typeof resolveSessionUser>>>;

/**
 * The shared authentication core both mechanisms funnel through, so the
 * security-relevant policy — the rate-limit gate, the password check, the
 * read-only session resolution, and the failure wording that must not
 * distinguish "no such user" from "wrong password" — is written once.
 * Each entry point owns only its own credential framing (PLAIN base64
 * decoding, LOGIN quote stripping) and its success response.
 *
 * Returns the resolved session user on success. On failure, writes the
 * tagged NO reply (and closes the socket when the rate limiter says so)
 * and returns null. Throws only on unexpected errors, which
 * handleAuthenticate converts to BAD (handleLogin has no SASL framing to
 * fail, so it lets them propagate as before).
 */
const authenticateCredentials = async (
  username: string,
  password: string,
  ip: string,
  socket: Socket,
  write: (data: string) => boolean | undefined,
  tag: string
): Promise<ResolvedSessionUser | null> => {
  if (isAuthRateLimited(ip)) {
    write(`${tag} NO [AUTHENTICATIONFAILED] Too many failed attempts\r\n`);
    closeSocket(socket);
    return null;
  }

  const user = await getUser({ username, password });
  const signedUser = user?.getSigned();

  const pwMatches = await verifyPassword(password, user?.password);

  if (!user || !signedUser || !pwMatches) {
    return failAuth(tag, ip, socket, write);
  }

  const resolved = await resolveSessionUser(signedUser);
  if (!resolved) {
    return failAuth(tag, ip, socket, write);
  }

  resetAuthFailures(ip);
  return resolved;
};

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

  try {
    const decoded = Buffer.from(initialResponse, "base64").toString("utf8");
    const parts = decoded.split("\0");

    if (parts.length !== 3) {
      write(`${tag} BAD Invalid PLAIN response format\r\n`);
      return null;
    }

    const [, username, password] = parts;

    const resolved = await authenticateCredentials(
      username,
      password,
      ip,
      socket,
      write,
      tag
    );
    if (!resolved) return null;

    // Auth-audit line — never behind the per-command threshold gate in
    // handler.ts (a fast bcrypt round on strong hardware would drop the
    // per-command "IMAP command completed" line to DEBUG). Auth events
    // need a durable INFO surface at the same level as CREATE / RENAME /
    // DELETE from mailbox-ops.ts. `authenticatedAs` names the original
    // credential (unchanged by the read-only remap) so a compromised
    // read-only credential does not read in the log as admin.
    logger.info("IMAP AUTHENTICATE success", {
      component: "imap",
      tag,
      authenticatedAs: username,
      effectiveUsername: resolved.user.username,
      isReadOnly: resolved.isReadOnly,
      remote: `${ip}:${socket.remotePort ?? 0}`,
      mechanism: "PLAIN",
    });
    write(
      `${tag} OK [CAPABILITY ${getCapabilities()}] AUTHENTICATE completed\r\n`
    );
    return {
      store: new Store(resolved.user),
      authenticated: true,
      isReadOnly: resolved.isReadOnly,
      authenticatedAs: username,
    };
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

  const [username, password] = args;
  const cleanUsername = username.replace(/^"(.*)"$/, "$1");
  const cleanPassword = password.replace(/^"(.*)"$/, "$1");

  const resolved = await authenticateCredentials(
    cleanUsername,
    cleanPassword,
    ip,
    socket,
    write,
    tag
  );
  if (!resolved) return null;

  // Auth-audit line — same rationale as the AUTHENTICATE success log
  // above. Threshold gate in handler.ts is scoped to per-command
  // memory/latency triage; auth events need their own INFO surface.
  logger.info("IMAP LOGIN success", {
    component: "imap",
    tag,
    authenticatedAs: cleanUsername,
    effectiveUsername: resolved.user.username,
    isReadOnly: resolved.isReadOnly,
    remote: `${ip}:${socket.remotePort ?? 0}`,
  });
  write(`${tag} OK [CAPABILITY ${getCapabilities()}] LOGIN completed\r\n`);
  return {
    store: new Store(resolved.user),
    authenticated: true,
    isReadOnly: resolved.isReadOnly,
    authenticatedAs: cleanUsername,
  };
}
