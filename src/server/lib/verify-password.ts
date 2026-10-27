/**
 * Constant-cost password verification for every credential surface — HTTP
 * login, IMAP LOGIN/AUTHENTICATE and SMTP AUTH.
 *
 * One implementation rather than one per surface, because the property these
 * surfaces need is invisible at the call site: a comparison skipped when the
 * account does not exist answers in microseconds where a real account takes
 * tens of milliseconds, which turns an unauthenticated listener into a
 * username oracle, and nothing about a refusal reveals which of the two a
 * caller got.
 */

/**
 * bcrypt cost for every stored digest. Shared with the stand-in below so the
 * two stay equally expensive.
 */
const BCRYPT_COST = 10;

/**
 * Stands in for the stored digest when there is nothing real to compare
 * against. Same cost as {@link hashPassword}; a cheaper stand-in would answer
 * in a fraction of the time a real account takes and leave the differential it
 * exists to erase.
 */
const DUMMY_HASH =
  "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

/**
 * bcrypt reads at most 72 bytes of key. `Bun.password` pre-hashes a longer
 * string with SHA-512 instead of truncating it, so a long password hashed by a
 * truncating bcrypt (bcryptjs, OpenBSD bcrypt) only verifies if the input is cut here.
 */
const BCRYPT_MAX_KEY_BYTES = 72;

const bcryptKey = (password: string): Uint8Array =>
  new TextEncoder().encode(password).subarray(0, BCRYPT_MAX_KEY_BYTES);

/**
 * Hashes a password for storage as a `$2b$` bcrypt digest.
 *
 * ```ts
 * await usersTable.update(id, { password: await hashPassword(password) });
 * ```
 */
export const hashPassword = (password: string): Promise<string> =>
  Bun.password.hash(bcryptKey(password), { algorithm: "bcrypt", cost: BCRYPT_COST });

/**
 * Compares a submitted password against a stored bcrypt digest, spending one
 * full bcrypt round whether or not the account exists.
 *
 * ```ts
 * const user = await getUser({ username });
 * const pwMatches = await verifyPassword(password, user?.password);
 * if (!user || !pwMatches) return refuse();
 * ```
 *
 * A missing password or a missing digest yields false — but only after the
 * round has been spent. The stand-in is substituted for any falsy stored value
 * because an empty digest is rejected without hashing at all, in microseconds
 * rather than tens of milliseconds. A stored value that is not a digest at all
 * also yields false rather than throwing.
 */
export const verifyPassword = async (
  password: string | undefined | null,
  storedHash: string | undefined | null
): Promise<boolean> => {
  const matches = await Bun.password
    .verify(bcryptKey(password ?? ""), storedHash || DUMMY_HASH)
    .catch(() => false);
  return Boolean(password && storedHash && matches);
};
