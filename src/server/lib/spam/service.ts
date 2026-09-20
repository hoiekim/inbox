/**
 * Spam Filter Service
 * 
 * 4-layer spam detection architecture:
 * - Layer 0: Allowlist check (skip trusted senders whose identity corroborates)
 * - Layer 1: DNS blocklist check (Spamhaus, Spamcop)
 * - Layer 2: Rule engine (header/content analysis)
 * - Layer 3: Placeholder for future ML classifier
 *
 * Layer 1 is evaluated before Layer 0 because a blocklisted connection
 * withdraws the Layer 0 exemption.
 */

import { SpamCheckResult, SpamFilterConfig, EmailContext } from "./types";
import { checkDnsbls as realCheckDnsbls, DEFAULT_DNSBLS } from "./dnsbl";
import { isEnvelopeAligned } from "./alignment";
import { logger } from "../logger";
import { evaluateRules, DEFAULT_RULES } from "./rules";
import { isAllowlisted as realIsAllowlisted } from "../postgres/repositories/spam_allowlists";
import { classifyEmail as realClassifyEmail } from "./classifier";

type IsAllowlistedFn = typeof realIsAllowlisted;
type ClassifyEmailFn = typeof realClassifyEmail;
type CheckDnsblsFn = typeof realCheckDnsbls;
export interface CheckSpamDeps {
  isAllowlisted?: IsAllowlistedFn;
  classifyEmail?: ClassifyEmailFn;
  checkDnsbls?: CheckDnsblsFn;
}

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
 * Why an allowlisted sender is denied the Layer 0 exemption, or null to grant it.
 *
 * The allowlist matches the `From:` header, which the sending client writes
 * freely. Granting a total bypass on that alone hands guaranteed delivery to
 * anyone who types an allowlisted address, so the exemption additionally
 * requires the two signals the server does not take on the sender's word: an
 * envelope sender that corroborates the header, and a connection that is not
 * on a blocklist.
 */
const exemptionRefusal = (email: EmailContext, dnsblScore: number): string | null => {
  if (!isEnvelopeAligned(email.fromAddress, email.envelopeFromAddress)) {
    return "Allowlisted sender not confirmed by the envelope sender";
  }
  if (dnsblScore > 0) {
    return "Allowlisted sender arrived from a blocklisted address";
  }
  return null;
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
  config: Partial<SpamFilterConfig> = {},
  deps: CheckSpamDeps = {},
): Promise<SpamCheckResult> {
  const isAllowlisted = deps.isAllowlisted ?? realIsAllowlisted;
  const classifyEmail = deps.classifyEmail ?? realClassifyEmail;
  const checkDnsbls = deps.checkDnsbls ?? realCheckDnsbls;
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const reasons: string[] = [];
  let totalScore = 0;
  let flaggedBy: SpamCheckResult["flaggedBy"];

  // Layer 1: DNS blocklist check
  let dnsblScore = 0;
  let dnsblReasons: string[] = [];
  if (cfg.enableDnsbl && email.remoteAddress) {
    try {
      const dnsblResult = await checkDnsbls(email.remoteAddress, cfg.dnsbls);
      dnsblScore = dnsblResult.score;
      dnsblReasons = dnsblResult.reasons;
    } catch (error) {
      logger.warn("[SpamFilter] DNSBL check failed", {}, error);
      // Continue with other checks
    }
  }

  // Layer 0: Allowlist check
  if (email.fromAddress) {
    try {
      const allowed = await isAllowlisted(userId, email.fromAddress);
      if (allowed) {
        const refusal = exemptionRefusal(email, dnsblScore);
        if (!refusal) {
          return {
            score: 0,
            reasons: ["Sender is allowlisted"],
            isSpam: false,
            flaggedBy: "allowlist",
          };
        }
        reasons.push(refusal);
      }
    } catch (error) {
      logger.warn("[SpamFilter] Allowlist check failed", {}, error);
      // Continue with other checks
    }
  }

  if (dnsblScore > 0) {
    totalScore += dnsblScore;
    reasons.push(...dnsblReasons);
    if (!flaggedBy) flaggedBy = "dnsbl";
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

  // Layer 3: Naive Bayes classifier (user-trained, per-user model)
  try {
    const { score: classifierScore, reason: classifierReason } = await classifyEmail(userId, email);
    // classifyEmail returns P(spam) * 100 in [0, 100], where < 50 is a HAM verdict
    // and >= 50 is a SPAM verdict (the classifier sets reason to non-null only at >= 50).
    // Only contribute to totalScore when the verdict leans spam — otherwise a
    // ham-leaning score (e.g. 49) would still inflate totalScore past spamThreshold
    // when combined with other layers, flipping legitimate mail to spam.
    if (classifierReason !== null) {
      totalScore += classifierScore;
      reasons.push(classifierReason);
      if (!flaggedBy) flaggedBy = "classifier";
    }
  } catch (error) {
    logger.warn("[SpamFilter] Classifier check failed", {}, error);
    // Continue — classifier failure is non-fatal
  }

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
  fromAddress: string,
  deps: { isAllowlisted?: IsAllowlistedFn } = {},
): Promise<boolean> {
  const isAllowlisted = deps.isAllowlisted ?? realIsAllowlisted;
  try {
    return await isAllowlisted(userId, fromAddress);
  } catch (error) {
    logger.warn("[SpamFilter] Allowlist lookup failed", {}, error);
    return false;
  }
}
