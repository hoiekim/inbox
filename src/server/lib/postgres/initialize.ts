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
  pushSubscriptionsTable,
} from "./models";

export const version = "1";
export const index = "inbox" + (version ? `-${version}` : "");

const tables: Table<unknown, Schema>[] = [
  usersTable,
  sessionsTable,
  mailsTable,
  pushSubscriptionsTable,
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

      for (const idx of table.indexes) {
        const createIndexSql = buildCreateIndex(table.name, idx.column);
        await pool.query(createIndexSql);
      }
    }

    // Run automatic schema migrations for existing tables
    await runMigrations(
      tables.map((t) => ({ name: t.name, schema: t.schema }))
    );

    // Create GIN index for full-text search on mails
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_mails_search 
      ON mails USING GIN(search_vector)
    `);

    // Add unique constraint on (user_id, message_id) to prevent duplicate emails
    // First check if constraint exists to avoid error on existing databases
    const constraintCheck = await pool.query(`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_name = 'mails' AND constraint_type = 'UNIQUE'
      AND constraint_name = 'mails_user_id_message_id_key'
    `);
    if (constraintCheck.rows.length === 0) {
      // Remove any existing duplicates before adding constraint
      await pool.query(`
        DELETE FROM mails a USING mails b
        WHERE a.mail_id > b.mail_id
        AND a.user_id = b.user_id
        AND a.message_id = b.message_id
      `);
      await pool.query(`
        ALTER TABLE mails
        ADD CONSTRAINT mails_user_id_message_id_key UNIQUE (user_id, message_id)
      `);
      console.info("Added unique constraint on mails(user_id, message_id)");
    }

    // Create trigger function for auto-updating search_vector
    await pool.query(`
      CREATE OR REPLACE FUNCTION mails_search_vector_trigger() RETURNS trigger AS $$
      BEGIN
        NEW.search_vector := to_tsvector('english', 
          coalesce(NEW.subject, '') || ' ' || 
          coalesce(NEW.text, '') || ' ' || 
          coalesce(NEW.from_text, '') || ' ' || 
          coalesce(NEW.to_text, '')
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
};
