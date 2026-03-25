import { pool } from "./client";
import { writeUser, searchUser } from "./repositories";
import { buildCreateTable, buildCreateIndex } from "./database";
import { runMigrations } from "./migration";
import {
  Table,
  Schema,
  usersTable,
  sessionsTable,
  mailsTable,
  mailboxesTable,
  pushSubscriptionsTable,
  spamAllowlistTable,
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
];

export const postgresIsAvailable = async (): Promise<void> => {
  const maxRetries = 30;
  let retries = 0;

  while (retries < maxRetries) {
    try {
      const client = await pool.connect();
      client.release();
      console.info("PostgreSQL connection established.");
      return;
    } catch (error: unknown) {
      retries++;
      const message = error instanceof Error ? error.message : String(error);
      console.info(`PostgreSQL connection attempt ${retries}/${maxRetries} failed: ${message}`);
      
      if (retries >= maxRetries) {
        throw new Error("Failed to connect to PostgreSQL after maximum retries");
      }
      
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
};

export const initializePostgres = async (): Promise<void> => {
  console.info("PostgreSQL initialization started.");

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

    // Create trigger function for auto-updating search_vector.
    // subject, from_text, and to_text are plain-text fields — escape angle brackets
    // before calling to_tsvector so that words like "alert" in a subject such as
    // "<alert>" are not silently stripped.  The text (HTML body) field is left as-is
    // because stripping HTML tags there is the desired behaviour.
    await pool.query(`
      CREATE OR REPLACE FUNCTION mails_search_vector_trigger() RETURNS trigger AS $$
      BEGIN
        NEW.search_vector := to_tsvector('english',
          coalesce(replace(replace(NEW.subject,   '<', ' '), '>', ' '), '') || ' ' ||
          coalesce(NEW.text, '') || ' ' ||
          coalesce(replace(replace(NEW.from_text, '<', ' '), '>', ' '), '') || ' ' ||
          coalesce(replace(replace(NEW.to_text,   '<', ' '), '>', ' '), '')
        );
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql;
    `);

    // Create trigger (drop first to handle updates)
    await pool.query(`DROP TRIGGER IF EXISTS mails_search_update ON mails`);
    await pool.query(`
      CREATE TRIGGER mails_search_update 
        BEFORE INSERT OR UPDATE ON mails 
        FOR EACH ROW EXECUTE FUNCTION mails_search_vector_trigger()
    `);

    // Reindex existing rows so that the corrected trigger is applied retroactively.
    // This is idempotent — a no-op when search_vector is already up to date.
    await pool.query(`
      UPDATE mails
      SET search_vector = to_tsvector('english',
        coalesce(replace(replace(subject,   '<', ' '), '>', ' '), '') || ' ' ||
        coalesce(text, '') || ' ' ||
        coalesce(replace(replace(from_text, '<', ' '), '>', ' '), '') || ' ' ||
        coalesce(replace(replace(to_text,   '<', ' '), '>', ' '), '')
      )
      WHERE search_vector IS DISTINCT FROM to_tsvector('english',
        coalesce(replace(replace(subject,   '<', ' '), '>', ' '), '') || ' ' ||
        coalesce(text, '') || ' ' ||
        coalesce(replace(replace(from_text, '<', ' '), '>', ' '), '') || ' ' ||
        coalesce(replace(replace(to_text,   '<', ' '), '>', ' '), '')
      )
    `);

    console.info("Database tables created/verified successfully.");
  } catch (error: unknown) {
    console.error("Failed to create tables:", error);
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
    email: "admin@localhost",
  });
  const createdAdminUserId = indexingAdminUserResult?._id;
  if (!createdAdminUserId) throw new Error("Failed to create admin user");

  console.info("Successfully initialized PostgreSQL database and setup admin user.");

  // Warn if EMAIL_DOMAIN is not explicitly configured.
  // Without a correct domain, getAccountStats() filters all emails out (domain condition)
  // causing the inbox to appear empty even when emails exist.
  if (!process.env.EMAIL_DOMAIN) {
    console.warn(
      "[CONFIG WARNING] EMAIL_DOMAIN is not set. Defaulting to 'mydomain'.\n" +
        "  The inbox will appear empty if your emails are addressed to a different domain.\n" +
        "  Set EMAIL_DOMAIN=yourdomain.com in your .env file to see incoming emails."
    );
  }
};
