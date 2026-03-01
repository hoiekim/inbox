/**
 * Spam Filter Module
 * 
 * Server-side spam filtering for incoming emails.
 * Provides 4-layer detection: allowlist, DNSBL, rules, and (future) ML classifier.
 */

export * from "./types";
export * from "./service";
export * from "./rules";
export * from "./dnsbl";
