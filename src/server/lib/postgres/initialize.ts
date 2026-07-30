import { pool } from "./client";
import { writeUser, searchUser } from "./repositories";
import { buildCreateTable, buildCreateIndex } from "./database";
import { runMigrations } from "./migration";
import { searchVectorDdl, searchVectorReindexSql } from "./search-vector";
import { logger } from "../logger";
import {
  Table,
  Schema,
  usersTable,
  sessionsTable,
  mailsTable,
  mailboxesTable,
  pushSubscriptionsTable,
  spamAllowlistTable,
  spamTrainingTable,
  mailUidCountersTable,
  mailMailboxUidTable,
  mailgunEventsTable,
} from "./models";

export const version = "1";
export const index = "inbox" + (version ? `-${version}` : "");

/** Every table the app owns, in DDL-creation order (FK dependencies first). */
export const tables: Table<unknown, Schema>[] = [
  usersTable,
  sessionsTable,
  mailboxesTable, // Must be before mails due to foreign key reference
  mailsTable,
  pushSubscriptionsTable,
  spamAllowlistTable,
  spamTrainingTable,
  mailUidCountersTable,
  // Depends on mails (FK to mails.mail_id ON DELETE CASCADE).
  mailMailboxUidTable,
  mailgunEventsTable,
];

export const postgresIsAvailable = async (): Promise<void> => {
  const maxRetries = 30;
  let retries = 0;

  while (retries < maxRetries) {
    try {
      const client = await pool.connect();
      client.release();
      logger.info("PostgreSQL connection established.");
      return;
    } catch (error: unknown) {
      retries++;
      const message = error instanceof Error ? error.message : String(error);
      logger.info(`PostgreSQL connection attempt ${retries}/${maxRetries} failed: ${message}`);
      
      if (retries >= maxRetries) {
        throw new Error("Failed to connect to PostgreSQL after maximum retries");
      }
      
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
};

export const initializePostgres = async (): Promise<void> => {
  logger.info("PostgreSQL initialization started.");

  await postgresIsAvailable();

  try {
    // Create tables if they don't exist
    for (const table of tables) {
      const createTableSql = buildCreateTable(
        table.name,
        table.schema,
        table.constraints
      );
      await pool.query(createTableSql);
    }

    // Run automatic schema migrations for existing tables
    // This must happen BEFORE index creation - new columns from schema
    // must exist before we try to create indexes on them
    await runMigrations(
      tables.map((t) => ({ name: t.name, schema: t.schema }))
    );

    // Create indexes after migrations ensure all columns exist
    for (const table of tables) {
      for (const idx of table.indexes) {
        const createIndexSql = buildCreateIndex(table.name, idx.column);
        await pool.query(createIndexSql);
      }
    }

    // Create GIN index for full-text search on mails
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_mails_search 
      ON mails USING GIN(search_vector)
    `);

    // Trigger function + the INSERT / column-scoped UPDATE trigger pair, then
    // the reindex — all three derived from `searchVectorExpression` so the
    // trigger and the direct write can't drift apart. See search-vector.ts.
    for (const sql of searchVectorDdl()) await pool.query(sql);
    await pool.query(searchVectorReindexSql());

    // #702 PR 3: retire `mails.uid_account` — `mail_mailbox_uid.uid` is now
    // the sole per-mailbox UID source. Drop the column when it still exists,
    // and bump every user's `imap_uid_validity` in the same transaction so
    // any client that was caching UIDs against the retired column resyncs
    // (RFC 3501 §2.3.1.1). Both steps are gated on the column's presence so
    // subsequent restarts are no-ops.
    const uidAccountCheck = await pool.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'mails'
        AND column_name = 'uid_account'
      LIMIT 1
    `);
    if ((uidAccountCheck.rowCount ?? 0) > 0) {
      logger.info("[Migration] #702 PR 3 — bumping imap_uid_validity and dropping mails.uid_account");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Bump UIDVALIDITY per user. FLOOR(EXTRACT(EPOCH FROM NOW())) matches
        // the seed used by `getImapUidValidity` on first IMAP access — a
        // monotonically-increasing unix-seconds value.
        await client.query(`
          UPDATE users
          SET imap_uid_validity = FLOOR(EXTRACT(EPOCH FROM NOW()))::INTEGER
          WHERE imap_uid_validity IS NOT NULL
        `);
        // IF EXISTS so a concurrent rolling-deploy loser (raced through the
        // presence check above, then found the winner had already dropped
        // the column) completes cleanly instead of throwing. Postgres emits
        // a NOTICE not an error for a missing column, so the loser's
        // transaction still COMMITs — including its own UPDATE users, which
        // bumps UIDVALIDITY a second time. Functionally fine (a
        // few-seconds-later UIDVALIDITY bump is still monotonically
        // increasing), just not idempotent to the same-second value.
        await client.query(`ALTER TABLE mails DROP COLUMN IF EXISTS uid_account`);
        await client.query("COMMIT");
        logger.info("[Migration] #702 PR 3 — done");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    logger.info("Database tables created/verified successfully.");
  } catch (error: unknown) {
    logger.error("Failed to create tables", {}, error);
    throw new Error("Failed to setup PostgreSQL tables.");
  }
};

export const initializeAdminUser = async (): Promise<void> => {
  const { ADMIN_PASSWORD } = process.env;

  const existingAdminUser = await searchUser({ username: "admin" });
  const indexingAdminUserResult = await writeUser({
    user_id: existingAdminUser?.user_id,
    username: "admin",
    password: ADMIN_PASSWORD || "inbox",
    // Pull the domain from EMAIL_DOMAIN so admin's identity stays consistent
    // with `getDomain()` everywhere else. Hardcoding `admin@localhost` made the
    // UI's default-account lookup miss every cloned mail in sandbox/dev
    // environments where EMAIL_DOMAIN was set but admin's email kept the
    // localhost fallback — `getAccountStats` filters by domain and returned 0
    // matches, so the inbox rendered empty even though data was present.
    email: `admin@${process.env.EMAIL_DOMAIN || "localhost"}`,
  });
  const createdAdminUserId = indexingAdminUserResult?._id;
  if (!createdAdminUserId) throw new Error("Failed to create admin user");

  logger.info("Successfully initialized PostgreSQL database and setup admin user.");

  // Warn if EMAIL_DOMAIN is not explicitly configured.
  // Without a correct domain, getAccountStats() filters all emails out (domain condition)
  // causing the inbox to appear empty even when emails exist.
  if (!process.env.EMAIL_DOMAIN) {
    logger.warn(
      "[CONFIG WARNING] EMAIL_DOMAIN is not set. Defaulting to 'mydomain'.\n" +
        "  The inbox will appear empty if your emails are addressed to a different domain.\n" +
        "  Set EMAIL_DOMAIN=yourdomain.com in your .env file to see incoming emails."
    );
  }
};
