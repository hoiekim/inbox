/**
 * Spam Filter Rule Engine
 * 
 * Layer 2: Rule-based spam scoring.
 * Applies configurable rules to email content and headers.
 */

import { SpamRule, EmailContext } from "./types";

/**
 * URL shortener domains commonly used in spam.
 */
const URL_SHORTENERS = [
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "ow.ly",
  "is.gd",
  "buff.ly",
  "adf.ly",
  "cutt.ly",
  "rebrand.ly",
  "short.link",
];

/**
 * Extract text content from email for analysis.
 */
function getTextContent(email: EmailContext): string {
  return email.text || email.html?.replace(/<[^>]*>/g, " ") || "";
}

/**
 * Check if subject has excessive uppercase.
 */
function hasExcessiveUppercase(text: string): boolean {
  if (!text || text.length < 5) return false;
  const letters = text.replace(/[^a-zA-Z]/g, "");
  if (letters.length < 5) return false;
  const uppercase = letters.replace(/[^A-Z]/g, "").length;
  return uppercase / letters.length > 0.5;
}

/**
 * Check if text contains URL shorteners.
 */
function containsUrlShortener(text: string): boolean {
  const lowerText = text.toLowerCase();
  return URL_SHORTENERS.some(domain => lowerText.includes(domain));
}

/**
 * Check if email looks like marketing but lacks unsubscribe.
 */
function isMarketingWithoutUnsubscribe(email: EmailContext): boolean {
  const text = getTextContent(email).toLowerCase();
  const hasMarketingIndicators = 
    text.includes("special offer") ||
    text.includes("limited time") ||
    text.includes("act now") ||
    text.includes("buy now") ||
    text.includes("click here") ||
    text.includes("free gift") ||
    text.includes("exclusive deal");
  
  const hasUnsubscribe = 
    text.includes("unsubscribe") ||
    text.includes("opt out") ||
    text.includes("opt-out") ||
    text.includes("manage preferences");

  return hasMarketingIndicators && !hasUnsubscribe;
}

/**
 * Default spam detection rules.
 * Each rule checks a specific spam indicator and assigns a score.
 */
export const DEFAULT_RULES: SpamRule[] = [
  {
    id: "missing-from",
    name: "Missing From header",
    score: 20,
    check: (email) => !email.fromAddress && !email.fromName,
  },
  {
    id: "reply-to-mismatch",
    name: "Reply-To differs from From",
    score: 15,
    check: (email) => {
      if (!email.replyToAddress || !email.fromAddress) return false;
      // Extract domain from addresses
      const fromDomain = email.fromAddress.split("@")[1]?.toLowerCase();
      const replyDomain = email.replyToAddress.split("@")[1]?.toLowerCase();
      // Different domains is suspicious
      return fromDomain !== replyDomain;
    },
  },
  {
    id: "excessive-caps-subject",
    name: "Subject >50% uppercase",
    score: 10,
    check: (email) => hasExcessiveUppercase(email.subject || ""),
  },
  {
    id: "url-shortener",
    name: "URL shorteners in body",
    score: 25,
    check: (email) => containsUrlShortener(getTextContent(email)),
  },
  {
    id: "marketing-no-unsubscribe",
    name: "Marketing without unsubscribe",
    score: 15,
    check: (email) => isMarketingWithoutUnsubscribe(email),
  },
  {
    id: "empty-subject",
    name: "Empty subject line",
    score: 10,
    check: (email) => !email.subject || email.subject.trim() === "",
  },
  {
    id: "excessive-exclamation",
    name: "Excessive exclamation marks in subject",
    score: 10,
    check: (email) => {
      const subject = email.subject || "";
      const exclamations = (subject.match(/!/g) || []).length;
      return exclamations >= 3;
    },
  },
  {
    id: "suspicious-phrases",
    name: "Contains suspicious spam phrases",
    score: 15,
    check: (email) => {
      const text = getTextContent(email).toLowerCase();
      const suspiciousPhrases = [
        "congratulations you have won",
        "you are a winner",
        "claim your prize",
        "urgent action required",
        "your account will be suspended",
        "verify your account immediately",
        "nigerian prince",
        "wire transfer",
        "lottery winner",
      ];
      return suspiciousPhrases.some(phrase => text.includes(phrase));
    },
  },
  {
    id: "cryptocurrency-spam",
    name: "Cryptocurrency spam indicators",
    score: 20,
    check: (email) => {
      const text = getTextContent(email).toLowerCase();
      const cryptoSpamIndicators = [
        "bitcoin investment",
        "crypto millionaire",
        "guaranteed returns",
        "double your bitcoin",
        "free crypto",
      ];
      return cryptoSpamIndicators.some(phrase => text.includes(phrase));
    },
  },
  {
    id: "html-only-no-text",
    name: "HTML-only email with no text alternative",
    score: 5,
    check: (email) => !!email.html && !email.text,
  },
];

/**
 * Run all rules against an email and return matching rules with total score.
 */
export function evaluateRules(
  email: EmailContext,
  rules: SpamRule[] = DEFAULT_RULES
): { score: number; matchedRules: SpamRule[] } {
  const matchedRules: SpamRule[] = [];
  let score = 0;

  for (const rule of rules) {
    try {
      if (rule.check(email)) {
        matchedRules.push(rule);
        score += rule.score;
      }
    } catch (error) {
      // Rule threw an error - log but don't crash
      console.warn(`[SpamFilter] Rule '${rule.id}' threw error:`, error);
    }
  }

  return { score, matchedRules };
}
