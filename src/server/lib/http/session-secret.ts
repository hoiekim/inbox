import { isProduction } from "../env";
import { logger } from "../logger";

/** The key a non-production boot signs with when SECRET is unset. */
export const DEVELOPMENT_FALLBACK = "inbox-development-session-secret";

/**
 * Values this repository publishes — in its own source, in .env.example, and as
 * the development fallback itself. A deployment signing with one of these has
 * no cookie integrity at all, because the key is readable by anyone, so they
 * are treated the same as an unset secret rather than as a configured one.
 */
const PUBLISHED_VALUES = new Set(["secret", "inbox", DEVELOPMENT_FALLBACK]);

const RECOMMENDED_LENGTH = 32;

const GENERATE = "generate one with `openssl rand -base64 32`";

/**
 * Resolve the key that signs session cookies.
 *
 * Production refuses to boot on a missing or publicly known key: either one
 * lets anyone mint a validly-signed cookie for a session id they have seen,
 * which is the whole guarantee the signature exists to provide. A key that is
 * merely shorter than the recommended length is still private, so it warns
 * instead — refusing it would cost availability while denying an attacker
 * nothing.
 *
 * Outside production nothing is fatal and a missing key resolves to a fixed
 * development value, so a local checkout needs no setup.
 *
 * Called from the boot path rather than module scope because a module-scope
 * read cannot be exercised by a test: ESM imports hoist above any assignment
 * the test would make.
 */
export const resolveSessionSecret = (): string => {
  const secret = process.env["SECRET"];
  const value = secret?.trim();

  if (!secret || !value) {
    if (isProduction())
      throw new Error(
        "SECRET is not set, so session cookies would be signed with a key published in this " +
          `repository — anyone could forge one. Set SECRET in the deployment environment (${GENERATE}).`
      );
    logger.warn(
      "[CONFIG WARNING] SECRET is not set, so session cookies are signed with a fixed\n" +
        "  development key that this repository publishes. Production refuses to boot without\n" +
        `  a real one — ${GENERATE} and set SECRET before deploying.`
    );
    return DEVELOPMENT_FALLBACK;
  }

  if (PUBLISHED_VALUES.has(value)) {
    if (isProduction())
      throw new Error(
        "SECRET is set to a value published in this repository, so every session cookie is " +
          `forgeable. Set a private SECRET in the deployment environment (${GENERATE}).`
      );
    logger.warn(
      "[CONFIG WARNING] SECRET is a value published in this repository, so it grants session\n" +
        `  cookies no integrity. Production refuses to boot on it — ${GENERATE} and set SECRET\n` +
        "  before deploying."
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
