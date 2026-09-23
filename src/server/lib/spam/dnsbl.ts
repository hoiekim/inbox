/**
 * DNS Blocklist (DNSBL) Checker
 * 
 * Layer 1: Check sending IP against known DNS blocklists.
 * If an IP is listed, it indicates known spam source.
 */

import { promises as dns } from "dns";
import { DnsBlocklist } from "./types";

/** Timeout for individual DNSBL queries (in ms) */
const DNSBL_TIMEOUT_MS = 2000;

/**
 * Default DNS blocklists to check.
 * These are reputable, widely-used blocklists.
 */
export const DEFAULT_DNSBLS: DnsBlocklist[] = [
  {
    hostname: "zen.spamhaus.org",
    name: "Spamhaus ZEN",
    score: 40,
  },
  {
    hostname: "bl.spamcop.net",
    name: "SpamCop",
    score: 30,
  },
  {
    hostname: "b.barracudacentral.org",
    name: "Barracuda",
    score: 25,
  },
];

/** Prefix a dual-stack listener puts in front of an IPv4 peer address. */
const IPV4_MAPPED_PREFIX = "::ffff:";

/**
 * The dotted quad an address denotes, or null if it denotes none.
 *
 * A listener bound without a host reports an IPv4 peer in the mapped form
 * `::ffff:198.51.100.7`, which no blocklist answers for. Unwrapping it is what
 * lets one host get the same verdict over either socket family.
 */
export function toIpv4(ip: string): string | null {
  const quad = ip.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)
    ? ip.slice(IPV4_MAPPED_PREFIX.length)
    : ip;
  const parts = quad.split(".");
  if (parts.length !== 4) return null;
  if (!parts.every(p => /^\d+$/.test(p) && parseInt(p) >= 0 && parseInt(p) <= 255)) {
    return null;
  }
  return quad;
}

/**
 * Reverse a dotted quad for DNSBL lookup.
 * For IPv4: 1.2.3.4 -> 4.3.2.1
 */
function reverseIp(ipv4: string): string {
  return ipv4.split(".").reverse().join(".");
}

/**
 * Create a promise that rejects after a timeout.
 */
function timeout<T>(ms: number, message: string): Promise<T> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

/**
 * Decide whether a DNSBL response represents a real listing.
 *
 * Major DNSBLs (Spamhaus, SpamCop, Barracuda) encode genuine listings as
 * `127.0.0.X` records. Anything in the `127.255.X.X` range is a warning that
 * the query was rejected — most commonly Spamhaus's open/public-resolver
 * response (returned when queries arrive via Google/Cloudflare/etc.). Treating
 * those warnings as listings flags every incoming mail as spam.
 *
 * Reference: https://www.spamhaus.org/zen/ (Return Codes section)
 */
export const isRealListing = (addresses: string[]): boolean =>
  addresses.some((addr) => addr.startsWith("127.0."));

/** What one blocklist said about an address: it listed it, cleared it, or never answered. */
export type DnsblVerdict = "listed" | "clean" | "unknown";

/** DNS failures that mean "no such record" — how a blocklist spells "not listed". */
const NOT_LISTED_DNS_CODES = new Set(["ENOTFOUND", "ENODATA", "NOTFOUND", "NODATA"]);

/**
 * The verdict a DNSBL's successful response carries.
 *
 * A record came back, so the address is either listed or the response is one of
 * the warning codes `isRealListing` rejects — a query the blocklist declined to
 * answer, which is not a clearance.
 *
 * ```ts
 * verdictForAnswer(["127.0.0.2"]);       // "listed"
 * verdictForAnswer(["127.255.255.254"]); // "unknown" — open-resolver warning
 * ```
 */
export const verdictForAnswer = (addresses: string[]): DnsblVerdict =>
  isRealListing(addresses) ? "listed" : "unknown";

/**
 * The verdict a failed DNSBL query carries.
 *
 * Only the no-such-record codes mean "not listed". A timeout rejects with a
 * plain `Error` carrying no `code`, and a refusal or server failure describes
 * the resolver rather than the address, so neither clears it.
 *
 * ```ts
 * verdictForDnsError("ENOTFOUND"); // "clean"
 * verdictForDnsError("EREFUSED");  // "unknown"
 * verdictForDnsError(undefined);   // "unknown" — the timeout path
 * ```
 */
export const verdictForDnsError = (code?: string): DnsblVerdict =>
  code && NOT_LISTED_DNS_CODES.has(code) ? "clean" : "unknown";

/**
 * Ask one DNSBL about a dotted quad.
 * Times out after DNSBL_TIMEOUT_MS to prevent hanging.
 */
async function checkDnsbl(ipv4: string, dnsbl: DnsBlocklist): Promise<DnsblVerdict> {
  const query = `${reverseIp(ipv4)}.${dnsbl.hostname}`;

  try {
    // Race DNS query against timeout to prevent hanging
    const result = await Promise.race([
      dns.resolve4(query),
      timeout<string[]>(DNSBL_TIMEOUT_MS, `DNSBL query timeout: ${dnsbl.name}`),
    ]);
    return verdictForAnswer(result);
  } catch (error) {
    return verdictForDnsError((error as NodeJS.ErrnoException).code);
  }
}

/**
 * Check an IP against multiple DNSBLs.
 * Returns aggregated results.
 *
 * `evaluated` reports whether the score is a verdict or an absence of one, so a
 * caller that treats a clean address as authorization can tell the two apart.
 */
export async function checkDnsbls(
  ip: string,
  dnsbls: DnsBlocklist[] = DEFAULT_DNSBLS
): Promise<{
  score: number;
  listedIn: DnsBlocklist[];
  reasons: string[];
  evaluated: boolean;
}> {
  const ipv4 = toIpv4(ip);
  // An address outside IPv4 is one the blocklists cannot be asked about.
  if (!ipv4) {
    return { score: 0, listedIn: [], reasons: [], evaluated: false };
  }
  // A private or local address names no internet host, so no blocklist carries
  // it — "not listed" is a definite answer here, not a missing one.
  if (isPrivateIp(ipv4)) {
    return { score: 0, listedIn: [], reasons: [], evaluated: true };
  }

  const results = await Promise.allSettled(
    dnsbls.map(async dnsbl => ({
      dnsbl,
      verdict: await checkDnsbl(ipv4, dnsbl),
    }))
  );

  const listedIn: DnsBlocklist[] = [];
  const reasons: string[] = [];
  let score = 0;
  let evaluated = dnsbls.length > 0;

  for (const result of results) {
    if (result.status !== "fulfilled" || result.value.verdict === "unknown") {
      evaluated = false;
      continue;
    }
    if (result.value.verdict === "listed") {
      listedIn.push(result.value.dnsbl);
      score += result.value.dnsbl.score;
      reasons.push(`Listed in ${result.value.dnsbl.name}`);
    }
  }

  return { score, listedIn, reasons, evaluated };
}

/**
 * Check if a dotted quad is a private/local address that shouldn't be checked.
 */
function isPrivateIp(ipv4: string): boolean {
  const parts = ipv4.split(".").map(Number);

  // Localhost
  if (parts[0] === 127) return true;
  
  // Private ranges
  // 10.0.0.0/8
  if (parts[0] === 10) return true;
  // 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;
  // Link-local 169.254.0.0/16
  if (parts[0] === 169 && parts[1] === 254) return true;

  return false;
}
