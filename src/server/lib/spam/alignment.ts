/**
 * Sender alignment for the spam allowlist.
 *
 * SMTP authenticates neither the `From:` header nor the envelope `MAIL FROM`,
 * so a match on either one alone records a claim rather than an identity.
 * Requiring the two to agree is DMARC's relaxed-alignment rule: it costs a
 * forger control of the envelope as well as the header, which a sender
 * relaying through someone else's MTA does not have.
 */

/**
 * Domain half of an email address, lowercased.
 *
 * Returns undefined for anything that is not exactly one local part and one
 * domain, so a malformed address fails alignment rather than matching loosely.
 */
const domainOf = (address: string | undefined): string | undefined => {
  if (!address) return undefined;
  const parts = address.split("@");
  if (parts.length !== 2) return undefined;
  const [local, domain] = parts;
  if (!local || !domain) return undefined;
  return domain.toLowerCase();
};

/**
 * Whether the envelope sender and the header sender share a domain.
 *
 * Absent or malformed on either side counts as unaligned — a missing envelope
 * sender (`MAIL FROM:<>`) carries no identity to corroborate the header with.
 */
export const isEnvelopeAligned = (
  headerFromAddress: string | undefined,
  envelopeFromAddress: string | undefined
): boolean => {
  const headerDomain = domainOf(headerFromAddress);
  const envelopeDomain = domainOf(envelopeFromAddress);
  if (!headerDomain || !envelopeDomain) return false;
  return headerDomain === envelopeDomain;
};
