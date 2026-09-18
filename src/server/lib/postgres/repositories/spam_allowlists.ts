/**
 * Spam Allowlist Repository
 * 
 * CRUD operations for per-user spam allowlist entries.
 * All queries are delegated to SpamAllowlistTable methods.
 */

import { logger } from "../../logger";
import {
  AddAllowlistEntryResult,
  SpamAllowlistModel,
  SpamAllowlistJSON,
  spamAllowlistTable,
} from "../models/spam_allowlist";

/**
 * Get all allowlist entries for a user.
 */
export async function getAllowlistForUser(userId: string): Promise<SpamAllowlistModel[]> {
  return spamAllowlistTable.getAllForUser(userId);
}

/**
 * Check if an email address matches any allowlist entry for a user.
 * Returns true if the sender is allowlisted.
 */
export async function isAllowlisted(userId: string, emailAddress: string): Promise<boolean> {
  return spamAllowlistTable.isAllowlisted(userId, emailAddress);
}

/**
 * Add an allowlist entry for a user.
 * Refuses a duplicate, an oversized pattern, or a user at the row ceiling.
 */
export async function addAllowlistEntry(
  userId: string,
  pattern: string
): Promise<AddAllowlistEntryResult> {
  try {
    return await spamAllowlistTable.addEntry(userId, pattern);
  } catch (error) {
    logger.error("Error adding allowlist entry", {}, error);
    throw error;
  }
}

/**
 * Remove an allowlist entry by user + pattern (case-insensitive).
 */
export async function removeAllowlistEntry(
  userId: string,
  pattern: string
): Promise<boolean> {
  return spamAllowlistTable.removeByPattern(userId, pattern);
}

/**
 * Remove an allowlist entry by ID.
 */
export async function removeAllowlistEntryById(
  userId: string,
  allowlistId: string
): Promise<boolean> {
  return spamAllowlistTable.removeById(userId, allowlistId);
}
