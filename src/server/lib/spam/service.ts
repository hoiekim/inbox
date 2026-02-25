/**
 * Spam Filter Service
 * 
 * 4-layer spam detection architecture:
 * - Layer 0: Allowlist check (skip trusted senders)
 * - Layer 1: DNS blocklist check (Spamhaus, Spamcop)
 * - Layer 2: Rule engine (header/content analysis)
 * - Layer 3: Placeholder for future ML classifier
 */

import { SpamCheckResult, SpamFilterConfig, EmailContext } from "./types";
import { checkDnsbls, DEFAULT_DNSBLS } from "./dnsbl";
import { evaluateRules, DEFAULT_RULES } from "./rules";
import { isAllowlisted } from "../postgres/repositories/spamAllowlist";

/**
 * Default spam filter configuration.
 */
const DEFAULT_CONFIG: SpamFilterConfig = {
  spamThreshold: 50,
  enableDnsbl: true,
  dnsbls: DEFAULT_DNSBLS,
  enableRules: true,
  customRules: [],
};

/**
 * Check an incoming email for spam.
 * 
 * @param userId - The recipient user's ID (for allowlist lookup)
 * @param email - Email context with headers and content
 * @param config - Optional filter configuration
 * @returns Spam check result with score, reasons, and isSpam flag
 */
export async function checkSpam(
  userId: string,
  email: EmailContext,
  config: Partial<SpamFilterConfig> = {}
): Promise<SpamCheckResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const reasons: string[] = [];
  let totalScore = 0;
  let flaggedBy: SpamCheckResult["flaggedBy"];

  // Layer 0: Allowlist check
  if (email.fromAddress) {
    try {
      const allowed = await isAllowlisted(userId, email.fromAddress);
      if (allowed) {
        return {
          score: 0,
          reasons: ["Sender is allowlisted"],
          isSpam: false,
          flaggedBy: "allowlist",
        };
      }
    } catch (error) {
      console.warn("[SpamFilter] Allowlist check failed:", error);
      // Continue with other checks
    }
  }

  // Layer 1: DNS blocklist check
  if (cfg.enableDnsbl && email.remoteAddress) {
    try {
      const dnsblResult = await checkDnsbls(email.remoteAddress, cfg.dnsbls);
      if (dnsblResult.score > 0) {
        totalScore += dnsblResult.score;
        reasons.push(...dnsblResult.reasons);
        if (!flaggedBy) flaggedBy = "dnsbl";
      }
    } catch (error) {
      console.warn("[SpamFilter] DNSBL check failed:", error);
      // Continue with other checks
    }
  }

  // Layer 2: Rule engine
  if (cfg.enableRules) {
    const allRules = [...DEFAULT_RULES, ...(cfg.customRules || [])];
    const ruleResult = evaluateRules(email, allRules);
    if (ruleResult.score > 0) {
      totalScore += ruleResult.score;
      reasons.push(...ruleResult.matchedRules.map(r => r.name));
      if (!flaggedBy) flaggedBy = "rules";
    }
  }

  // Layer 3: ML classifier (placeholder for future implementation)
  // TODO: Add ML-based classification in Phase 2

  const isSpam = totalScore >= cfg.spamThreshold;

  return {
    score: totalScore,
    reasons,
    isSpam,
    flaggedBy: isSpam ? flaggedBy : undefined,
  };
}

/**
 * Quick check if sender is in user's allowlist.
 * Use this for fast skip before expensive checks.
 */
export async function isSenderAllowlisted(
  userId: string,
  fromAddress: string
): Promise<boolean> {
  try {
    return await isAllowlisted(userId, fromAddress);
  } catch (error) {
    console.warn("[SpamFilter] Allowlist lookup failed:", error);
    return false;
  }
}
