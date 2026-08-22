import { createHash } from "node:crypto";
import { pool } from "./client";
import { writeUser, searchUser } from "./repositories";
import { buildCreateTable, buildCreateIndex, buildIndexName } from "./database";
import { runBootMaintenance, MaintenanceWork, Statement } from "./maintenance";
import { sendAlarm } from "../alarm";
import {
  checkSchemaAtTarget,
  runMigrations,
  writeSchemaMarker,
  MarkerKey,
} from "./migration";
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

// The full-text search index predates `table.indexes` and keeps its original
// name — regenerating it as `idx_mails_search_vector_gin` would leave the
// existing index in place and build a duplicate alongside it.
const MAILS_SEARCH_INDEX_NAME = "idx_mails_search";

/** Gates the row-scaled phase independently of the fatal schema DDL. */
const MAINTENANCE_MARKER_KEY: MarkerKey = "maintenance_hash";

/** Ceiling on alarm delivery, so a wedged webhook cannot delay a stop. */
const MAINTENANCE_ALARM_TIMEOUT_MS = 5_000;

// Raw DDL that isn't captured by `table.schema` / `table.indexes` /
// `searchVector*`. Extracted as module-scoped constants so their literal
// text is what feeds `CURRENT_SCHEMA_HASH` below — the same string
// `indexSpecs()` hands to the maintenance phase. That way any edit to a raw
// block automatically changes the digest (no descriptive-sentinel discipline
// required).
const IDX_MAILS_SEARCH_SQL = buildCreateIndex("mails", "search_vector", {
  indexName: MAILS_SEARCH_INDEX_NAME,
  using: "gin",
  concurrently: true,
});

/**
 * Every index the app owns, as (name, statement) pairs. Names are exposed
 * alongside the SQL because the maintenance phase has to identify invalid
 * leftovers by name before it can rebuild them.
 */
export const indexSpecs = (): Statement[] => {
  const specs: Statement[] = [];
  for (const table of tables) {
    for (const idx of table.indexes) {
      const options = { using: idx.using, opclass: idx.opclass, concurrently: true };
      specs.push({
        name: buildIndexName(table.name, idx.column, options),
        sql: buildCreateIndex(table.name, idx.column, options),
      });
    }
  }
  specs.push({ name: MAILS_SEARCH_INDEX_NAME, sql: IDX_MAILS_SEARCH_SQL });
  return specs;
};

/** The statements `bootMaintenance` hands to the long-budget session. */
export const maintenanceWork = (): MaintenanceWork => ({
  indexes: indexSpecs(),
  statements: [
    { name: "search_vector reindex", sql: searchVectorReindexSql(), drain: true },
  ],
});

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

    // Trigger function + the INSERT / column-scoped UPDATE trigger pair. The
    // reindex they share an expression with runs in `bootMaintenance` — it is
    // the one statement here whose cost scales with the table.
    for (const sql of searchVectorDdl()) await pool.query(sql);

    // Record the marker so subsequent boots can fast-path. Written AFTER every
    // statement in this block succeeded, and gated only on them: the
    // row-scaled work in `bootMaintenance` has its own marker, because sending
    // every boot back through this throwing block for as long as an index
    // can't build would just move the crashloop rather than remove it.
    await writeSchemaMarker(CURRENT_SCHEMA_HASH);
  } catch (error: unknown) {
    logger.error("Failed to create tables", {}, error);
    throw new Error("Failed to setup PostgreSQL tables.");
  }

  logger.info("Database tables created/verified successfully.");
};

/**
 * The row-count-scaled half of the boot DDL: index builds and the search-vector
 * reindex. Deliberately NOT part of `initializePostgres`, on two counts.
 *
 * It must not be fatal. A statement here failing means "too slow for its
 * budget", not "the schema is broken" — the app serves correctly without an
 * index, and with a stale search vector on rows nothing has touched. Exiting
 * for it just crashloops the container into the same doomed statement, with
 * no port ever bound to diagnose from.
 *
 * And it must not gate the listeners. Index builds are `CONCURRENTLY` so the
 * table stays writable while they run, which buys nothing if HTTP/SMTP/IMAP
 * aren't up yet. `start.ts` calls this after binding and does not await it.
 *
 * It carries its own marker, separate from the schema one. That marker is what
 * lets a steady-state boot skip the phase entirely — without it every restart
 * would re-run a full-table tsvector recompute that changes nothing. Writing
 * it while a statement is still outstanding would strand that work forever,
 * with every later boot fast-pathing past it and no error anywhere, so it is
 * written only on a clean sweep.
 *
 * Never rejects: `start.ts` does not await it, so a rejection here would
 * surface as a contextless unhandled-rejection page.
 */
export const bootMaintenance = async (signal?: AbortSignal): Promise<void> => {
  try {
    if (await checkSchemaAtTarget(CURRENT_SCHEMA_HASH, MAINTENANCE_MARKER_KEY)) {
      logger.info("[Maintenance] Already at target — skipping.");
      return;
    }

    const result = await runBootMaintenance(maintenanceWork(), signal);
    if (result === "complete") {
      await writeSchemaMarker(CURRENT_SCHEMA_HASH, MAINTENANCE_MARKER_KEY);
      return;
    }
    // `skipped` means another instance is doing the work, or shutdown
    // cancelled it. Every rolling deploy produces one of those; paging for it
    // would train the alarm to be ignored.
    if (result === "skipped") return;

    const message =
      "Boot maintenance did not complete — an index or the search-vector reindex " +
      "is outstanding. The maintenance marker is withheld, so the next boot retries.";
    logger.warn(`[Maintenance] ${message}`);
    // Degrading instead of exiting must not also mean degrading silently. The
    // delivery is raced rather than awaited: `start.ts` awaits this phase on
    // the graceful-shutdown path, and `sendAlarm`'s fetch carries no timeout of
    // its own, so a wedged webhook would hold the stop open until compose's
    // grace period expired and SIGKILL replaced the clean exit.
    await Promise.race([
      sendAlarm("Boot Maintenance Incomplete", message).catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, MAINTENANCE_ALARM_TIMEOUT_MS)),
    ]);
  } catch (error: unknown) {
    logger.error("[Maintenance] Phase failed unexpectedly.", {}, error);
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
