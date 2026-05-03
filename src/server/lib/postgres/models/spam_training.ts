/**
 * Spam Training Model
 *
 * Stores per-user Naive Bayes training data for the spam classifier.
 * Each row tracks how many times a word has appeared in spam vs ham
 * emails for a specific user.
 */

import { Model, Table, Constraints } from "./base";
import { pool } from "../client";
import { SPAM_TRAINING, USER_ID } from "./common";

// Column names
export const TRAINING_ID = "training_id";
export const WORD = "word";
export const SPAM_COUNT = "spam_count";
export const HAM_COUNT = "ham_count";

// Type guards
const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number";

export interface SpamTrainingJSON {
  training_id: string;
  user_id: string;
  word: string;
  spam_count: number;
  ham_count: number;
}

const spamTrainingSchema = {
  [TRAINING_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [USER_ID]: "UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE",
  [WORD]: "VARCHAR(100) NOT NULL",
  [SPAM_COUNT]: "INTEGER NOT NULL DEFAULT 0",
  [HAM_COUNT]: "INTEGER NOT NULL DEFAULT 0",
};

type SpamTrainingSchema = typeof spamTrainingSchema;

export class SpamTrainingModel extends Model<SpamTrainingJSON, SpamTrainingSchema> {
  declare training_id: string;
  declare user_id: string;
  declare word: string;
  declare spam_count: number;
  declare ham_count: number;

  static typeChecker = {
    training_id: isString,
    user_id: isString,
    word: isString,
    spam_count: isNumber,
    ham_count: isNumber,
  };

  constructor(data: unknown) {
    super(data, SpamTrainingModel.typeChecker);
  }

  toJSON(): SpamTrainingJSON {
    return {
      training_id: this.training_id,
      user_id: this.user_id,
      word: this.word,
      spam_count: this.spam_count,
      ham_count: this.ham_count,
    };
  }
}

class SpamTrainingTable extends Table<SpamTrainingJSON, SpamTrainingSchema, SpamTrainingModel> {
  readonly name = SPAM_TRAINING;
  readonly primaryKey = TRAINING_ID;
  readonly schema = spamTrainingSchema;
  readonly constraints: Constraints = [`UNIQUE(${USER_ID}, ${WORD})`];
  readonly indexes = [{ column: USER_ID }];
  readonly ModelClass = SpamTrainingModel;
  readonly supportsSoftDelete = false;

  /**
   * Returns all training rows for a user.
   */
  async getAllForUser(userId: string): Promise<SpamTrainingModel[]> {
    const sql = `SELECT * FROM ${this.name} WHERE ${USER_ID} = $1`;
    const result = await pool.query<SpamTrainingJSON>(sql, [userId]);
    return result.rows.map((row) => new SpamTrainingModel(row));
  }

  /**
   * Returns the total number of spam and ham documents trained for a user.
   */
  async getDocCounts(userId: string): Promise<{ spamDocs: number; hamDocs: number }> {
    // We store total counts in a special sentinel row with word = "__total__"
    const sql = `
      SELECT ${SPAM_COUNT}, ${HAM_COUNT}
      FROM ${this.name}
      WHERE ${USER_ID} = $1 AND ${WORD} = $2
    `;
    const result = await pool.query<{ spam_count: number; ham_count: number }>(sql, [userId, "__total__"]);
    if (result.rows.length === 0) return { spamDocs: 0, hamDocs: 0 };
    return {
      spamDocs: result.rows[0].spam_count,
      hamDocs: result.rows[0].ham_count,
    };
  }

  /**
   * Trains the classifier with a set of words from a document.
   * isSpam=true trains as spam; isSpam=false trains as ham.
   * Also increments the total document count sentinel row.
   *
   * Issues all word upserts plus the __total__ sentinel as a single batched
   * INSERT ... VALUES (...), (...), ... ON CONFLICT statement to avoid the
   * N+1 round-trip pattern. De-duplicates input words first since the multi-row
   * VALUES form cannot upsert two rows with the same conflict key in one statement.
   */
  async train(userId: string, words: string[], isSpam: boolean): Promise<void> {
    if (words.length === 0) return;

    const spamIncrement = isSpam ? 1 : 0;
    const hamIncrement = isSpam ? 0 : 1;

    const uniqueWords = Array.from(new Set(words));
    const allWords = [...uniqueWords, "__total__"];

    const params: unknown[] = [userId, spamIncrement, hamIncrement];
    const valuesSql = allWords.map((w) => {
      params.push(w);
      return `($1, $${params.length}, $2, $3)`;
    });

    const sql = `
      INSERT INTO ${this.name} (${USER_ID}, ${WORD}, ${SPAM_COUNT}, ${HAM_COUNT})
      VALUES ${valuesSql.join(", ")}
      ON CONFLICT (${USER_ID}, ${WORD})
      DO UPDATE SET
        ${SPAM_COUNT} = ${this.name}.${SPAM_COUNT} + EXCLUDED.${SPAM_COUNT},
        ${HAM_COUNT} = ${this.name}.${HAM_COUNT} + EXCLUDED.${HAM_COUNT}
    `;
    await pool.query(sql, params);
  }

  /**
   * Returns word counts for a batch of words for a user.
   * Only returns rows that exist in the DB.
   */
  async getWordCounts(userId: string, words: string[]): Promise<SpamTrainingModel[]> {
    if (words.length === 0) return [];
    const placeholders = words.map((_, i) => `$${i + 2}`).join(", ");
    const sql = `
      SELECT * FROM ${this.name}
      WHERE ${USER_ID} = $1 AND ${WORD} IN (${placeholders})
    `;
    const result = await pool.query<SpamTrainingJSON>(sql, [userId, ...words]);
    return result.rows.map((row) => new SpamTrainingModel(row));
  }

  /**
   * Deletes all training data for a user (reset).
   */
  async clearForUser(userId: string): Promise<void> {
    await pool.query(`DELETE FROM ${this.name} WHERE ${USER_ID} = $1`, [userId]);
  }
}

export const spamTrainingTable = new SpamTrainingTable();
