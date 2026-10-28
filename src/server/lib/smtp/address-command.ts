import { isIPv4, isIPv6 } from "net";
import { domainToUnicode } from "url";
import type { SmtpAddress } from "./types";

/** RFC 5321 §4.5.3.1.3: a path is at most 256 octets including `<`, `>` and `@`. */
const MAX_ADDRESS_LENGTH = 253;

const isValidDomain = (domain: string): boolean => {
  if (domain.startsWith("[") && domain.endsWith("]")) {
    const literal = domain.slice(1, -1);
    if (/^ipv6:/i.test(literal)) return isIPv6(literal.slice(5));
    return isIPv4(literal);
  }
  return !(
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain.includes("..") ||
    domain.includes(".-") ||
    domain.includes("-.") ||
    !/^[a-zA-Z0-9\u0080-￿.-]+$/.test(domain)
  );
};

const punycodeToUnicode = (domain: string): string =>
  domain
    .split(".")
    .map((label) => (label.startsWith("xn--") ? domainToUnicode(label) || label : label))
    .join(".");

/**
 * Parses the argument of `MAIL FROM:<...>` or `RCPT TO:<...>` (`verb` names
 * which), with any `KEY=value` ESMTP parameters. Answers `false` for a line
 * that is not that verb or whose address is malformed; `<>` parses to an
 * empty address.
 *
 * @example
 * parseAddressCommand("mail from", "MAIL FROM:<a@example.com> SIZE=1024")
 * // => { address: "a@example.com", args: { SIZE: "1024" } }
 */
export const parseAddressCommand = (verb: string, line: string): SmtpAddress | false => {
  const colon = line.indexOf(":");
  const name = (colon === -1 ? line : line.slice(0, colon)).trim().toUpperCase();
  if (name !== verb.toUpperCase()) return false;

  const parts = (colon === -1 ? "" : line.slice(colon + 1)).trim().split(/\s+/);
  const bracketed = parts.shift() ?? "";
  if (!/^<[^<>]*>$/.test(bracketed)) return false;
  let address = bracketed.slice(1, -1);

  let args: Record<string, string | true> | false = false;
  for (const part of parts) {
    const [rawKey, ...rest] = part.split("=");
    const key = rawKey.toUpperCase();
    if (!key.trim()) continue;
    const joined = rest.join("=");
    const value: string | true = joined
      ? joined.replace(/\+([0-9A-F]{2})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
      : true;
    args ||= {};
    args[key] = value;
  }

  if (address) {
    const pieces = address.split("@");
    if (pieces.length !== 2 || !pieces[0] || !pieces[1]) return false;
    const [local, domain] = pieces;
    if (local.length + 1 + domain.length > MAX_ADDRESS_LENGTH) return false;
    if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
    if (!isValidDomain(domain)) return false;
    const isLiteral = domain.startsWith("[");
    address = `${local}@${isLiteral ? domain : punycodeToUnicode(domain)}`;
  }

  return { address, args };
};
