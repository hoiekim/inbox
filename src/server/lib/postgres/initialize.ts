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
  spamAllowlistTable,
} from "./models";

export const version = "1";
export const index = "inbox" + (version ? `-${version}` : "");

const tables: Table<unknown, Schema>[] = [
  usersTable,
  sessionsTable,
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
