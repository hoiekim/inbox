import { pool } from "./client";
import { writeUser, searchUser } from "./repositories";
import { buildCreateTable, buildCreateIndex } from "./database";
import {
  Table,
  usersTable,
  sessionsTable,
  mailsTable,
  pushSubscriptionsTable,
} from "./models";

export const version = "1";
export const index = "inbox" + (version ? `-${version}` : "");

const tables: Table<unknown, any>[] = [
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
