/**
 * Spam Filter Types
 * 
 * Type definitions for the spam filtering system.
 */

/**
 * Result of a spam check operation.
 */
export interface SpamCheckResult {
  /** Cumulative spam score (higher = more likely spam) */
  score: number;
  /** Human-readable reasons for the score */
  reasons: string[];
  /** Whether the email exceeds the spam threshold */
  isSpam: boolean;
  /** Which layer flagged the email (if any) */
  flaggedBy?: 'allowlist' | 'dnsbl' | 'rules' | 'classifier';
}

/**
 * Rule definition for the rule engine.
 */
export interface SpamRule {
  /** Unique rule identifier */
  id: string;
  /** Human-readable rule name */
  name: string;
  /** Points to add to spam score if rule matches */
  score: number;
  /** Function that checks if the rule matches */
  check: (email: EmailContext) => boolean;
}

/**
 * Email context passed to spam rules for evaluation.
 */
export interface EmailContext {
  /** From header address */
  fromAddress?: string;
  /** From header display name */
  fromName?: string;
  /** Reply-To address */
  replyToAddress?: string;
  /** Email subject */
  subject?: string;
  /** Plain text body */
  text?: string;
  /** HTML body */
  html?: string;
  /** Sending IP address */
  remoteAddress?: string;
  /** All headers as key-value pairs */
  headers?: Record<string, string>;
}

/**
 * Allowlist entry for trusted senders.
 */
export interface AllowlistEntry {
  id: string;
  userId: string;
  /** Email pattern: exact (user@example.com) or domain wildcard (*@example.com) */
  pattern: string;
  createdAt: string;
}

/**
 * DNS blocklist configuration.
 */
export interface DnsBlocklist {
  /** Blocklist hostname (e.g., zen.spamhaus.org) */
  hostname: string;
  /** Human-readable name */
  name: string;
  /** Points to add if IP is listed */
  score: number;
}

/**
 * Configuration for the spam filter service.
 */
export interface SpamFilterConfig {
  /** Score threshold for marking as spam (default: 50) */
  spamThreshold: number;
  /** Whether to enable DNS blocklist checks (default: true) */
  enableDnsbl: boolean;
  /** DNS blocklists to check */
  dnsbls: DnsBlocklist[];
  /** Whether to enable rule engine (default: true) */
  enableRules: boolean;
  /** Custom rules to add to default rules */
  customRules?: SpamRule[];
}
