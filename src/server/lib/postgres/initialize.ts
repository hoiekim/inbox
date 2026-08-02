import { createHash } from "node:crypto";
import { pool } from "./client";
import { writeUser, searchUser } from "./repositories";
import { buildCreateTable, buildCreateIndex } from "./database";
import { checkSchemaAtTarget, runMigrations, writeSchemaMarker } from "./migration";
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

const tables: Table<unknown, Schema>[] = [
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

// Raw DDL that isn't captured by `table.schema` / `table.indexes` /
// `searchVector*`. Extracted as module-scoped constants so their literal
// text is what feeds `CURRENT_SCHEMA_HASH` below — the same string the
// slow path issues. That way any edit to a raw block automatically
// changes the digest (no descriptive-sentinel discipline required).
const IDX_MAILS_SEARCH_SQL = `
      CREATE INDEX IF NOT EXISTS idx_mails_search
      ON mails USING GIN(search_vector)
    `;

// Digest of every input the slow-path DDL consumes. Any code change to a
// table schema, its indexes, its constraints, `searchVectorDdl()`,
// `searchVectorReindexSql()`, or the raw DDL constants above changes this
// digest — the fast path only short-circuits when the DB reflects THIS
// exact code's DDL, so trigger-body-only and index-only PRs (which a
// name-check would silently miss) correctly fall through to the slow path.
export const CURRENT_SCHEMA_HASH: string = ((): string => {
  const parts: string[] = [];
  for (const t of tables) {
    parts.push(`t:${t.name}`);
    parts.push(JSON.stringify(t.schema));
    parts.push(JSON.stringify(t.indexes));
    parts.push(JSON.stringify(t.constraints ?? []));
  }
  parts.push(...searchVectorDdl());
  parts.push(searchVectorReindexSql());
  parts.push(IDX_MAILS_SEARCH_SQL);
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
})();

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

  // Fast-path: on the happy path (steady-state boot, no DDL change
  // deployed), the DB's `schema_meta.schema_hash` matches
  // `CURRENT_SCHEMA_HASH` and we skip the entire DDL block below —
  // CREATE TABLE × 10 + runMigrations (advisory-lock transaction) +
  // CREATE INDEX × 20+ + trigger DDL. That's ~35+
  // round-trips, each subject to `statement_timeout`. The pre-flight is
  // one SELECT. Under a restart where the PG instance is under load
  // from other containers, the old path can crashloop (2026-08-01
  // 17:19-17:22 PDT — 5 consecutive `Failed to create tables / Query
  // read timeout` before the 6th restart stuck).
  //
  // Any mismatch (marker missing, hash different, query failure) falls
  // through to the authoritative slow path. The slow path always writes
  // `schema_meta.schema_hash = CURRENT_SCHEMA_HASH` on success, so the
  // next boot fast-paths.
  if (await checkSchemaAtTarget(CURRENT_SCHEMA_HASH)) {
    logger.info("[Fast-path] Schema already at target — skipping DDL.");
    logger.info("Database tables created/verified successfully.");
    return;
  }

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
    await pool.query(IDX_MAILS_SEARCH_SQL);

    // Trigger function + the INSERT / column-scoped UPDATE trigger pair, then
    // the reindex — all three derived from `searchVectorExpression` so the
    // trigger and the direct write can't drift apart. See search-vector.ts.
    for (const sql of searchVectorDdl()) await pool.query(sql);
    await pool.query(searchVectorReindexSql());

    // Record the marker so subsequent boots can fast-path. Written AFTER
    // every DDL succeeded — if any step above threw, we don't want the
    // marker in the DB.
    await writeSchemaMarker(CURRENT_SCHEMA_HASH);

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
