/**
 * Spam Training Repository
 *
 * CRUD operations for per-user Naive Bayes training data.
 * All writes are delegated to SpamTrainingTable methods.
 */

import { logger } from "../../logger";
import { spamTrainingTable } from "../models/spam_training";

/**
 * Train the classifier for a user with a document's words.
 * isSpam=true trains as spam; isSpam=false trains as ham.
 */
export async function trainClassifier(
  userId: string,
  words: string[],
  isSpam: boolean
): Promise<void> {
  try {
    await spamTrainingTable.train(userId, words, isSpam);
  } catch (error) {
    logger.error("Error training spam classifier", {}, error);
    throw error;
  }
}

/**
 * Returns the total spam/ham document counts for a user's classifier.
 */
export async function getClassifierDocCounts(
  userId: string
): Promise<{ spamDocs: number; hamDocs: number }> {
  return spamTrainingTable.getDocCounts(userId);
}

/**
 * Returns per-word training counts for the given words.
 */
export async function getWordCounts(
  userId: string,
  words: string[]
): Promise<Map<string, { spamCount: number; hamCount: number }>> {
  const rows = await spamTrainingTable.getWordCounts(userId, words);
  const map = new Map<string, { spamCount: number; hamCount: number }>();
  for (const row of rows) {
    map.set(row.word, { spamCount: row.spam_count, hamCount: row.ham_count });
  }
  return map;
}

/**
 * Clears all training data for a user (full reset).
 */
export async function clearClassifierData(userId: string): Promise<void> {
  try {
    await spamTrainingTable.clearForUser(userId);
  } catch (error) {
    logger.error("Error clearing spam training data", {}, error);
    throw error;
  }
}
