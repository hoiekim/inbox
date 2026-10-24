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
  resolveSessionUser,
} from "server";
import {
  isAuthRateLimited,
  normalizeAuthAccount,
  recordAuthFailure,
  resetAuthFailures,
} from "../auth-rate-limit";
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
  /**
   * The credential generation the session was minted from.
   * Read from the credential row at auth time — the per-command gate
   * compares this against the row's current version.
   */
  passwordVersion: number;
}

/** Shared failure reply: rate-limit exhaustion closes the socket, anything
 * else is a flat "Invalid credentials" that reveals nothing about which
 * check failed. */
const failAuth = async (
  tag: string,
  ip: string,
  socket: Socket,
  write: (data: string) => boolean | undefined,
  account?: string
): Promise<null> => {
  const limited = await recordAuthFailure(ip, account);
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
): Promise<(ResolvedSessionUser & { passwordVersion: number }) | null> => {
  // The attempted identity: failures accumulate per (ip, account) and the
  // success below forgives only this account's own bucket. The per-IP
  // aggregate is never reset here, so alternating accounts from one IP
  // cannot wipe the counter.
  const account = normalizeAuthAccount(username);
  if (isAuthRateLimited(ip, account)) {
    write(`${tag} NO [AUTHENTICATIONFAILED] Too many failed attempts\r\n`);
    closeSocket(socket);
    return null;
  }

  const user = await getUser({ username, password });
  const signedUser = user?.getSigned();

  const pwMatches = await verifyPassword(password, user?.password);

  if (!user || !signedUser || !pwMatches) {
    return failAuth(tag, ip, socket, write, account);
  }

  const resolved = await resolveSessionUser(signedUser);
  if (!resolved) {
    return failAuth(tag, ip, socket, write, account);
  }

  // Scoped reset: forgive only the authenticating account's own bucket. The
  // per-IP aggregate keeps its count, so a success here cannot wipe another
  // account's failures from the same IP.
  resetAuthFailures(ip, account);
  // Stamp the credential row's generation — the per-command gate compares
  // this against the row's current version. Read here, at auth time, so a
  // LOGIN that straddled a rotation stamps the stale generation and fails
  // its next comparison. Keyed on the credential the caller
  // presented, never the remapped effective user: the read-only credential
  // is its own row and survives a rotation on the account it reads.
  return { ...resolved, passwordVersion: user.passwordVersion ?? 1 };
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
      passwordVersion: resolved.passwordVersion,
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
    passwordVersion: resolved.passwordVersion,
  };
}
