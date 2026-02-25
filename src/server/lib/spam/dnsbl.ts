/**
 * DNS Blocklist (DNSBL) Checker
 * 
 * Layer 1: Check sending IP against known DNS blocklists.
 * If an IP is listed, it indicates known spam source.
 */

import { promises as dns } from "dns";
import { DnsBlocklist } from "./types";

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

/**
 * Reverse an IP address for DNSBL lookup.
 * For IPv4: 1.2.3.4 -> 4.3.2.1
 */
function reverseIp(ip: string): string | null {
  // Only handle IPv4 for now
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  if (!parts.every(p => /^\d+$/.test(p) && parseInt(p) >= 0 && parseInt(p) <= 255)) {
    return null;
  }
  return parts.reverse().join(".");
}

/**
 * Check if an IP is listed in a specific DNSBL.
 * Returns true if listed, false otherwise.
 */
async function checkDnsbl(ip: string, dnsbl: DnsBlocklist): Promise<boolean> {
  const reversed = reverseIp(ip);
  if (!reversed) return false;

  const query = `${reversed}.${dnsbl.hostname}`;
  
  try {
    const result = await dns.resolve4(query);
    // If we get any result, the IP is listed
    return result.length > 0;
  } catch {
    // NXDOMAIN (not listed) or other DNS errors
    // Not listed = not spam indicator
    return false;
  }
}

/**
 * Check an IP against multiple DNSBLs.
 * Returns aggregated results.
 */
export async function checkDnsbls(
  ip: string,
  dnsbls: DnsBlocklist[] = DEFAULT_DNSBLS
): Promise<{ score: number; listedIn: DnsBlocklist[]; reasons: string[] }> {
  // Skip private/local IPs
  if (isPrivateIp(ip)) {
    return { score: 0, listedIn: [], reasons: [] };
  }

  const results = await Promise.allSettled(
    dnsbls.map(async dnsbl => ({
      dnsbl,
      listed: await checkDnsbl(ip, dnsbl),
    }))
  );

  const listedIn: DnsBlocklist[] = [];
  const reasons: string[] = [];
  let score = 0;

  for (const result of results) {
    if (result.status === "fulfilled" && result.value.listed) {
      listedIn.push(result.value.dnsbl);
      score += result.value.dnsbl.score;
      reasons.push(`Listed in ${result.value.dnsbl.name}`);
    }
  }

  return { score, listedIn, reasons };
}

/**
 * Check if an IP is a private/local address that shouldn't be checked.
 */
function isPrivateIp(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return true; // Not valid IPv4, skip

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
