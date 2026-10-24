import { getUser } from "server";

/**
 * The credential row's current password_version for `username` — the
 * generation the revocation fence (issue #1016) compares a grant's stamped
 * version against.
 *
 * Rows that predate the fence's migration read back null and count as
 * generation 1, the same default the migration's DEFAULT 1 gives every
 * existing row. A missing row also reads as 1: nothing about a credential
 * that was never issued can be behind.
 */
export const getCredentialPasswordVersion = async (
  username: string
): Promise<number> => {
  const user = await getUser({ username });
  return user?.passwordVersion ?? 1;
};
