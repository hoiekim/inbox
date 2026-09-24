import { randomBytes } from "node:crypto";
import { isProduction } from "../env";
import { logger } from "../logger";
import { sendAlarm } from "../alarm";

type Notify = (title: string, detail: string, key?: string) => Promise<void>;

/**
 * The key a non-production boot signs with when SECRET is unset. Changing this
 * value invalidates every outstanding cookie on a deployment that never opted
 * into the production posture, logging its users out to swap one published key
 * for another, so it stays fixed.
 */
export const DEVELOPMENT_FALLBACK = "secret";

/**
 * Values this repository publishes — in its own source, in .env.example, and as
 * the development fallback itself. A deployment signing with one of these has
 * no cookie integrity at all, because the key is readable by anyone, so they
 * are treated the same as an unset secret rather than as a configured one.
 */
const PUBLISHED_VALUES = new Set([DEVELOPMENT_FALLBACK, "inbox"]);

const RECOMMENDED_LENGTH = 32;

const GENERATE = "generate one with `openssl rand -base64 32`";

/**
 * Generates the process's key, alarms and logs an error demanding a real one,
 * then returns it. Kept out of the two call sites in `resolveSessionSecret` so
 * the alarm — the only signal that reaches an operator once boot stops
 * throwing — can't be added to one branch and forgotten on the other.
 */
const degradeInProduction = (reason: string, generateSecret: () => string, notify: Notify): string => {
  const detail =
    `${reason} Generated a random key for this process instead of refusing to boot; ` +
    `every session will be invalidated on the next restart. Set a private SECRET in the ` +
    `deployment environment (${GENERATE}).`;
  logger.error(detail);
  notify("SECRET Misconfigured", detail, "session-secret").catch(() => undefined);
  return generateSecret();
};

/**
 * Resolve the key that signs session cookies.
 *
 * A missing or publicly known key gives session cookies no integrity: either
 * one lets anyone mint a validly-signed cookie for a session id they have
 * seen. Production never signs with one — instead of refusing to boot, it
 * generates a fresh random key and alarms demanding a real one, so a
 * deployment that hasn't configured SECRET yet stays reachable rather than
 * crash-looping, at the cost of invalidating every session on the next
 * restart. `resolveSessionSecret` is called exactly once, at boot, so the
 * generated key holds for the life of the process; it is not memoized here,
 * so a second call would mint a different key and desync from cookies the
 * first key already signed. A key that is merely shorter than the recommended
 * length is still private, so it only warns — refusing it would cost
 * availability while denying an attacker nothing.
 *
 * Outside production nothing is fatal and a missing key resolves to a fixed
 * development value, so a local checkout needs no setup.
 *
 * Called from the boot path rather than module scope because a module-scope
 * read cannot be exercised by a test: ESM imports hoist above any assignment
 * the test would make. `generateSecret` and `notify` default to the real
 * CSPRNG and Discord alarm and exist so a test can substitute spies without
 * touching the process-global crypto or alarm modules.
 */
export const resolveSessionSecret = (
  generateSecret: () => string = () => randomBytes(32).toString("base64"),
  notify: Notify = sendAlarm
): string => {
  const secret = process.env["SECRET"];
  const value = secret?.trim();

  if (!secret || !value) {
    if (isProduction()) {
      return degradeInProduction(
        "SECRET is not set, so session cookies would be signed with a key published in this " +
          "repository — anyone could forge one.",
        generateSecret,
        notify
      );
    }
    logger.warn(
      "[CONFIG WARNING] SECRET is not set, so session cookies are signed with a fixed\n" +
        "  development key that this repository publishes. Production generates a random\n" +
        `  one instead — ${GENERATE} and set SECRET before deploying.`
    );
    return DEVELOPMENT_FALLBACK;
  }

  if (PUBLISHED_VALUES.has(value)) {
    if (isProduction()) {
      return degradeInProduction(
        "SECRET is set to a value published in this repository, so every session cookie is " +
          "forgeable.",
        generateSecret,
        notify
      );
    }
    logger.warn(
      "[CONFIG WARNING] SECRET is a value published in this repository, so it grants session\n" +
        `  cookies no integrity. Production generates a random one instead — ${GENERATE} and\n` +
        "  set SECRET before deploying."
    );
  } else if (value.length < RECOMMENDED_LENGTH) {
    logger.warn(
      `[CONFIG WARNING] SECRET is shorter than the recommended ${RECOMMENDED_LENGTH} characters, which\n` +
        `  weakens the session cookie signature against an offline search — ${GENERATE}.`,
      { length: value.length }
    );
  }

  // The untrimmed value: trimming here would change the signing key of a
  // deployment whose secret has surrounding whitespace and log every user out.
  return secret;
};
