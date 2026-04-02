/**
 * Naive Bayes Spam Classifier
 *
 * Layer 3 of the 4-layer spam detection architecture.
 * Learns from user feedback (mark-as-spam / not-spam) to adapt to
 * each user's specific spam patterns.
 *
 * Algorithm: Multinomial Naive Bayes with Laplace (add-1) smoothing.
 * Features: tokenized word frequencies from subject + body.
 *
 * Score: 0–100 (probability that the email is spam, scaled to match
 * the existing SpamFilterConfig.spamThreshold convention).
 *
 * The classifier only fires when sufficient training data exists
 * (MIN_TRAINING_DOCS per class). Below that threshold it returns
 * score=0 and skips classification to avoid false positives.
 */

import { logger } from "../logger";
import {
  trainClassifier,
  getClassifierDocCounts,
  getWordCounts,
} from "../postgres/repositories/spam_training";
import { EmailContext } from "./types";

/** Minimum number of spam + ham documents before the classifier will score. */
const MIN_TRAINING_DOCS = 5;

/** Maximum number of distinct words to extract from a single document. */
const MAX_WORDS_PER_DOCUMENT = 500;

/** Words shorter than this are ignored (stop-word-like). */
const MIN_WORD_LENGTH = 3;

/**
 * Tokenizes text into lowercase words for Naive Bayes feature extraction.
 * Strips HTML tags, punctuation, and numbers. Deduplicates and caps to
 * MAX_WORDS_PER_DOCUMENT to keep DB writes bounded.
 */
export function tokenize(text: string): string[] {
  // Strip HTML tags
  const stripped = text.replace(/<[^>]+>/g, " ");
  // Extract word tokens (letters only, 3+ chars)
  const words = stripped
    .toLowerCase()
    .match(/[a-z]{3,}/g) ?? [];
  // Deduplicate and cap
  const unique = [...new Set(words)].slice(0, MAX_WORDS_PER_DOCUMENT);
  return unique.filter((w) => w.length >= MIN_WORD_LENGTH);
}

/**
 * Extracts tokens from an EmailContext (subject + body).
 */
export function extractTokens(email: EmailContext): string[] {
  const parts: string[] = [];
  if (email.subject) parts.push(email.subject);
  if (email.text) parts.push(email.text);
  if (email.html) parts.push(email.html);
  return tokenize(parts.join(" "));
}

/**
 * Trains the classifier for a user with an email document.
 *
 * @param userId - The user who labeled the email
 * @param email  - The email that was labeled
 * @param isSpam - true if the user marked it as spam; false for "not spam"
 */
export async function trainWithEmail(
  userId: string,
  email: EmailContext,
  isSpam: boolean
): Promise<void> {
  const words = extractTokens(email);
  if (words.length === 0) {
    logger.warn("[Classifier] No tokens extracted from email — skipping training", { userId });
    return;
  }
  await trainClassifier(userId, words, isSpam);
  logger.info("[Classifier] Training sample recorded", {
    userId,
    isSpam,
    wordCount: words.length,
  });
}

/**
 * Scores an email using the user's trained Naive Bayes classifier.
 *
 * Returns a score in [0, 100]:
 * - Score ≥ 50 conventionally means "spam" (matches SpamFilterConfig.spamThreshold).
 * - Returns 0 when there isn't enough training data yet.
 *
 * @param userId - The recipient user
 * @param email  - The incoming email to score
 */
export async function classifyEmail(
  userId: string,
  email: EmailContext
): Promise<{ score: number; reason: string | null }> {
  try {
    const { spamDocs, hamDocs } = await getClassifierDocCounts(userId);
    const totalDocs = spamDocs + hamDocs;

    if (totalDocs < MIN_TRAINING_DOCS || spamDocs === 0 || hamDocs === 0) {
      // Not enough data to make a reliable prediction
      return { score: 0, reason: null };
    }

    const words = extractTokens(email);
    if (words.length === 0) {
      return { score: 0, reason: null };
    }

    // Prior probabilities (log space to avoid underflow)
    const logPriorSpam = Math.log(spamDocs / totalDocs);
    const logPriorHam = Math.log(hamDocs / totalDocs);

    // Fetch word counts for the tokens present in this email
    const wordCountMap = await getWordCounts(userId, words);

    // Vocabulary size (total distinct words seen across both classes).
    // We approximate with wordCountMap.size + 1 for unseen words.
    // Laplace smoothing: P(word|class) = (count + 1) / (totalWordsInClass + vocabSize)
    // For simplicity, we use (count + 1) / (docCount + 2) per word (binary approximation).
    let logPSpam = logPriorSpam;
    let logPHam = logPriorHam;

    for (const word of words) {
      const counts = wordCountMap.get(word);
      // Laplace smoothing: add 1 to both numerator and denominator
      const spamWordCount = (counts?.spamCount ?? 0) + 1;
      const hamWordCount = (counts?.hamCount ?? 0) + 1;
      const spamDenom = spamDocs + 2;
      const hamDenom = hamDocs + 2;

      logPSpam += Math.log(spamWordCount / spamDenom);
      logPHam += Math.log(hamWordCount / hamDenom);
    }

    // Convert log probabilities to a spam probability [0, 1]
    // P(spam | words) = exp(logPSpam) / (exp(logPSpam) + exp(logPHam))
    // Use the log-sum-exp trick for numerical stability
    const maxLog = Math.max(logPSpam, logPHam);
    const expSpam = Math.exp(logPSpam - maxLog);
    const expHam = Math.exp(logPHam - maxLog);
    const pSpam = expSpam / (expSpam + expHam);

    // Scale to [0, 100] to match the existing SpamFilterConfig.spamThreshold
    const score = Math.round(pSpam * 100);

    const reason =
      score >= 50
        ? `Bayesian classifier: ${score}% spam probability (${spamDocs} spam / ${hamDocs} ham documents trained)`
        : null;

    return { score, reason };
  } catch (error) {
    logger.warn("[Classifier] Classification failed", {}, error);
    return { score: 0, reason: null };
  }
}
