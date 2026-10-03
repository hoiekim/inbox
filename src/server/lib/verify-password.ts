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

import bcrypt from "bcryptjs";

/**
 * Stands in for the stored digest when there is nothing real to compare
 * against. Cost 10 matches what `encryptPassword` hashes at; a cheaper
 * stand-in would answer in a fraction of the time a real account takes and
 * leave the differential it exists to erase.
 */
const DUMMY_HASH =
  "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

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
 * because bcryptjs rejects an empty digest without hashing at all, in
 * microseconds rather than tens of milliseconds.
 */
export const verifyPassword = async (
  password: string | undefined | null,
  storedHash: string | undefined | null
): Promise<boolean> => {
  const matches = await bcrypt.compare(password ?? "", storedHash || DUMMY_HASH);
  return Boolean(password && storedHash && matches);
};
