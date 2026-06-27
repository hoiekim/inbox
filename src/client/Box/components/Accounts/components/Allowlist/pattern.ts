/**
 * Allowlist pattern validation — mirrors the server-side checks in
 * `src/server/lib/http/routes/mails/post-allowlist.ts` so the client rejects
 * malformed input before it ever hits the network.
 *
 * Valid shapes:
 *   - exact email:     `user@example.com`
 *   - domain wildcard: `*@example.com`
 */
const EXACT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_WILDCARD = /^\*@[^\s@]+\.[^\s@]+$/;

export const isValidAllowlistPattern = (pattern: string): boolean => {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  return EXACT_EMAIL.test(trimmed) || DOMAIN_WILDCARD.test(trimmed);
};
