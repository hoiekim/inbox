/**
 * Spam Allowlist Repository
 * 
 * CRUD operations for per-user spam allowlist entries.
 */

import { pool } from "../client";
import { SPAM_ALLOWLIST, USER_ID } from "../models/common";
import { PATTERN, SpamAllowlistModel, SpamAllowlistJSON } from "../models/spamAllowlist";

/**
 * Get all allowlist entries for a user.
 */
export async function getAllowlistForUser(userId: string): Promise<SpamAllowlistModel[]> {
  const result = await pool.query<SpamAllowlistJSON>(
    `SELECT * FROM ${SPAM_ALLOWLIST} WHERE ${USER_ID} = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows.map(row => new SpamAllowlistModel(row));
}

/**
 * Check if an email address matches any allowlist entry for a user.
 * Returns true if the sender is allowlisted.
 */
export async function isAllowlisted(userId: string, emailAddress: string): Promise<boolean> {
  const normalizedEmail = emailAddress.toLowerCase();
  const domain = normalizedEmail.split("@")[1];
  
  // Check for exact match or domain wildcard match
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM ${SPAM_ALLOWLIST} 
     WHERE ${USER_ID} = $1 
     AND (
       LOWER(${PATTERN}) = $2 
       OR LOWER(${PATTERN}) = $3
     )`,
    [userId, normalizedEmail, `*@${domain}`]
  );
  
  return parseInt(result.rows[0]?.count || "0") > 0;
}

/**
 * Add an allowlist entry for a user.
 */
export async function addAllowlistEntry(
  userId: string,
  pattern: string
): Promise<SpamAllowlistModel | null> {
  const normalizedPattern = pattern.toLowerCase();
  
  try {
    const result = await pool.query<SpamAllowlistJSON>(
      `INSERT INTO ${SPAM_ALLOWLIST} (${USER_ID}, ${PATTERN}) 
       VALUES ($1, $2) 
       ON CONFLICT (${USER_ID}, ${PATTERN}) DO NOTHING
       RETURNING *`,
      [userId, normalizedPattern]
    );
    
    if (result.rows.length === 0) {
      // Entry already exists
      return null;
    }
    
    return new SpamAllowlistModel(result.rows[0]);
  } catch (error) {
    console.error("Error adding allowlist entry:", error);
    throw error;
  }
}

/**
 * Remove an allowlist entry.
 */
export async function removeAllowlistEntry(
  userId: string,
  pattern: string
): Promise<boolean> {
  const normalizedPattern = pattern.toLowerCase();
  
  const result = await pool.query(
    `DELETE FROM ${SPAM_ALLOWLIST} 
     WHERE ${USER_ID} = $1 AND LOWER(${PATTERN}) = $2`,
    [userId, normalizedPattern]
  );
  
  return (result.rowCount ?? 0) > 0;
}

/**
 * Remove an allowlist entry by ID.
 */
export async function removeAllowlistEntryById(
  userId: string,
  allowlistId: string
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM ${SPAM_ALLOWLIST} 
     WHERE ${USER_ID} = $1 AND allowlist_id = $2`,
    [userId, allowlistId]
  );
  
  return (result.rowCount ?? 0) > 0;
}
