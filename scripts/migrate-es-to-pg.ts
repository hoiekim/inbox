/**
 * Migration script: Elasticsearch → PostgreSQL
 *
 * This script:
 * 1. Connects to Elasticsearch at 192.168.0.32:9200
 * 2. Reads all data from index inbox-2
 * 3. Transforms and inserts into local PostgreSQL
 *
 * Usage: npx ts-node scripts/migrate-es-to-pg.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { Client } from "@elastic/elasticsearch";
import { Pool, types } from "pg";
import crypto from "crypto";
import bcrypt from "bcrypt";

// ES Client
const esClient = new Client({
  node: "http://192.168.0.32:9200",
  auth: {
    username: "elastic",
    password: "elastic",
  },
});

// PG Client
const pgPool = new Pool({
  host: process.env.POSTGRES_HOST || "localhost",
  port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
  user: process.env.POSTGRES_USER || "postgres",
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DATABASE || "inbox",
  types: {
    getTypeParser(id, format) {
      if (id === types.builtins.NUMERIC) return parseFloat;
      if (id === types.builtins.INT8) return parseFloat;
      return types.getTypeParser(id, format);
    },
  },
});

const ES_INDEX = "inbox-2";

interface ESDocument {
  type: "mail" | "user" | "session" | "push_subscription";
  mail?: Record<string, unknown>;
  user?: Record<string, unknown>;
  session?: Record<string, unknown>;
  push_subscription?: Record<string, unknown>;
  updated?: string;
}

interface ESHit {
  _id: string;
  _source: ESDocument;
}

interface UserIdMap {
  [esId: string]: string; // ES ID -> PG UUID
}

// Helper to create tables
async function createTables() {
  console.log("Creating tables...");

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255),
      email VARCHAR(255),
      expiry TIMESTAMPTZ,
      token VARCHAR(255),
      updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      is_deleted BOOLEAN DEFAULT FALSE
    )
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id VARCHAR(255) PRIMARY KEY,
      session_user_id UUID NOT NULL,
      session_username VARCHAR(255) NOT NULL,
      session_email VARCHAR(255) NOT NULL,
      cookie_original_max_age BIGINT,
      cookie_max_age BIGINT,
      cookie_signed BOOLEAN,
      cookie_expires TIMESTAMPTZ,
      cookie_http_only BOOLEAN,
      cookie_path TEXT,
      cookie_domain TEXT,
      cookie_secure VARCHAR(10),
      cookie_same_site VARCHAR(20),
      updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS mails (
      mail_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      message_id VARCHAR(512) NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      date TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      html TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      from_address JSONB,
      from_text TEXT,
      to_address JSONB,
      to_text TEXT,
      cc_address JSONB,
      cc_text TEXT,
      bcc_address JSONB,
      bcc_text TEXT,
      reply_to_address JSONB,
      reply_to_text TEXT,
      envelope_from JSONB,
      envelope_to JSONB,
      search_vector TSVECTOR,
      attachments JSONB,
      read BOOLEAN NOT NULL DEFAULT FALSE,
      saved BOOLEAN NOT NULL DEFAULT FALSE,
      sent BOOLEAN NOT NULL DEFAULT FALSE,
      deleted BOOLEAN NOT NULL DEFAULT FALSE,
      draft BOOLEAN NOT NULL DEFAULT FALSE,
      insight JSONB,
      uid_domain INTEGER NOT NULL DEFAULT 0,
      uid_account INTEGER NOT NULL DEFAULT 0,
      updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      push_subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL,
      keys_p256dh TEXT NOT NULL,
      keys_auth TEXT NOT NULL,
      last_notified TIMESTAMPTZ,
      updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(session_user_id)`);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(cookie_expires)`);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_mails_user ON mails(user_id)`);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_mails_date ON mails(date)`);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_mails_sent ON mails(sent)`);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_mails_read ON mails(read)`);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_mails_saved ON mails(saved)`);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_mails_uid_domain ON mails(uid_domain)`);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_mails_uid_account ON mails(uid_account)`);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_mails_search ON mails USING GIN(search_vector)`);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id)`);

  // Create trigger for auto-updating search_vector
  await pgPool.query(`
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
  await pgPool.query(`DROP TRIGGER IF EXISTS mails_search_update ON mails`);
  await pgPool.query(`
    CREATE TRIGGER mails_search_update 
      BEFORE INSERT OR UPDATE ON mails 
      FOR EACH ROW EXECUTE FUNCTION mails_search_vector_trigger()
  `);

  console.log("Tables, indexes, and triggers created.");
}

// Helper to drop tables (for schema changes)
async function dropTables() {
  console.log("Dropping existing tables for fresh schema...");
  await pgPool.query("DROP TABLE IF EXISTS push_subscriptions CASCADE");
  await pgPool.query("DROP TABLE IF EXISTS mails CASCADE");
  await pgPool.query("DROP TABLE IF EXISTS sessions CASCADE");
  await pgPool.query("DROP TABLE IF EXISTS users CASCADE");
  console.log("Tables dropped.");
}

// Fetch all documents of a type from ES using scroll API
async function fetchESDocuments(docType: string): Promise<ESHit[]> {
  console.log(`Fetching ${docType} documents from ES...`);

  const allHits: ESHit[] = [];
  const batchSize = 1000;

  // Initial search with scroll (v7 API uses body wrapper)
  let response = await esClient.search({
    index: ES_INDEX,
    size: batchSize,
    scroll: "2m",
    body: { query: { term: { type: docType } } },
  });

  let scrollId = response.body._scroll_id;
  let hits = response.body.hits.hits as unknown as ESHit[];
  allHits.push(...hits);
  console.log(`  Fetched ${allHits.length} ${docType} documents so far...`);

  // Continue scrolling
  while (hits.length > 0 && scrollId) {
    response = await esClient.scroll({
      scroll_id: scrollId,
      scroll: "2m",
    });

    scrollId = response.body._scroll_id;
    hits = response.body.hits.hits as unknown as ESHit[];
    if (hits.length === 0) break;

    allHits.push(...hits);
    console.log(`  Fetched ${allHits.length} ${docType} documents so far...`);
  }

  // Clear scroll context
  if (scrollId) {
    await esClient.clearScroll({ scroll_id: scrollId }).catch(() => {});
  }

  console.log(`  Total ${docType} documents: ${allHits.length}`);
  return allHits;
}

// Migrate users
async function migrateUsers(): Promise<UserIdMap> {
  const userHits = await fetchESDocuments("user");
  const idMap: UserIdMap = {};

  console.log("Migrating users to PostgreSQL...");

  for (const hit of userHits) {
    const esId = hit._id;
    const user = hit._source.user || {};

    // Generate new UUID for PG
    const pgId = crypto.randomUUID();
    idMap[esId] = pgId;

    // Also map user.id if it exists and is different
    if (user.id && user.id !== esId) {
      idMap[user.id as string] = pgId;
    }

    const sql = `
      INSERT INTO users (user_id, username, password, email, expiry, token, updated, is_deleted)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (user_id) DO UPDATE SET
        username = EXCLUDED.username,
        password = EXCLUDED.password,
        email = EXCLUDED.email,
        expiry = EXCLUDED.expiry,
        token = EXCLUDED.token,
        updated = EXCLUDED.updated
    `;

    await pgPool.query(sql, [
      pgId,
      user.username || `user_${esId.slice(0, 8)}`,
      user.password || null,
      user.email || null,
      user.expiry || null,
      user.token || null,
      hit._source.updated || new Date().toISOString(),
      false,
    ]);
  }

  console.log(`  Migrated ${userHits.length} users.`);
  return idMap;
}

// Migrate sessions
async function migrateSessions(userIdMap: UserIdMap): Promise<void> {
  const sessionHits = await fetchESDocuments("session");

  console.log("Migrating sessions to PostgreSQL...");

  let migrated = 0;
  let skipped = 0;

  for (const hit of sessionHits) {
    const esId = hit._id;
    const session = hit._source.session || {};
    const user = (session.user || {}) as Record<string, unknown>;
    const cookie = (session.cookie || {}) as Record<string, unknown>;

    const esUserId = (user.id as string) || "";
    const pgUserId = userIdMap[esUserId];

    if (!pgUserId) {
      skipped++;
      continue;
    }

    const sql = `
      INSERT INTO sessions (
        session_id, session_user_id, session_username, session_email,
        cookie_original_max_age, cookie_max_age, cookie_signed, cookie_expires,
        cookie_http_only, cookie_path, cookie_domain, cookie_secure, cookie_same_site,
        updated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (session_id) DO UPDATE SET
        session_user_id = EXCLUDED.session_user_id,
        session_username = EXCLUDED.session_username,
        session_email = EXCLUDED.session_email,
        cookie_expires = EXCLUDED.cookie_expires,
        updated = EXCLUDED.updated
    `;

    await pgPool.query(sql, [
      esId,
      pgUserId,
      user.username || "unknown",
      user.email || "unknown@localhost",
      cookie.originalMaxAge ?? null,
      cookie.maxAge ?? null,
      cookie.signed ?? null,
      cookie._expires ?? null,
      cookie.httpOnly ?? null,
      cookie.path ?? null,
      cookie.domain ?? null,
      typeof cookie.secure === "string" ? cookie.secure : JSON.stringify(cookie.secure),
      typeof cookie.sameSite === "string" ? cookie.sameSite : JSON.stringify(cookie.sameSite),
      hit._source.updated || new Date().toISOString(),
    ]);

    migrated++;
  }

  console.log(`  Migrated ${migrated} sessions (skipped ${skipped} without valid user).`);
}

// Migrate mails
async function migrateMails(userIdMap: UserIdMap): Promise<void> {
  const mailHits = await fetchESDocuments("mail");

  console.log("Migrating mails to PostgreSQL...");

  let migrated = 0;
  let skipped = 0;

  // Also need to get user ID from the document structure
  for (const hit of mailHits) {
    const mail = hit._source.mail || {};
    const docUser = (hit._source as unknown as Record<string, unknown>).user as
      | Record<string, unknown>
      | undefined;
    const esUserId = docUser?.id as string;

    const pgUserId = userIdMap[esUserId];

    if (!pgUserId) {
      skipped++;
      continue;
    }

    const sql = `
      INSERT INTO mails (
        mail_id, user_id, message_id, subject, date, html, text,
        from_address, from_text, to_address, to_text,
        cc_address, cc_text, bcc_address, bcc_text,
        reply_to_address, reply_to_text,
        envelope_from, envelope_to, attachments,
        read, saved, sent, deleted, draft, insight,
        uid_domain, uid_account, updated, search_vector
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13, $14, $15,
        $16, $17,
        $18, $19, $20,
        $21, $22, $23, $24, $25, $26,
        $27, $28, $29,
        to_tsvector('english', coalesce($4, '') || ' ' || coalesce($7, '') || ' ' || coalesce($9, '') || ' ' || coalesce($11, ''))
      )
    `;

    const fromAddr = mail.from as Record<string, unknown> | undefined;
    const toAddr = mail.to as Record<string, unknown> | undefined;
    const ccAddr = mail.cc as Record<string, unknown> | undefined;
    const bccAddr = mail.bcc as Record<string, unknown> | undefined;
    const replyTo = mail.replyTo as Record<string, unknown> | undefined;
    const uid = (mail.uid || {}) as Record<string, unknown>;

    try {
      await pgPool.query(sql, [
        crypto.randomUUID(),
        pgUserId,
        mail.messageId || `unknown_${crypto.randomUUID()}`,
        mail.subject || "",
        mail.date || new Date().toISOString(),
        mail.html || "",
        mail.text || "",
        fromAddr?.value ? JSON.stringify(fromAddr.value) : null,
        fromAddr?.text || null,
        toAddr?.value ? JSON.stringify(toAddr.value) : null,
        toAddr?.text || null,
        ccAddr?.value ? JSON.stringify(ccAddr.value) : null,
        ccAddr?.text || null,
        bccAddr?.value ? JSON.stringify(bccAddr.value) : null,
        bccAddr?.text || null,
        replyTo?.value ? JSON.stringify(replyTo.value) : null,
        replyTo?.text || null,
        mail.envelopeFrom ? JSON.stringify(mail.envelopeFrom) : null,
        mail.envelopeTo ? JSON.stringify(mail.envelopeTo) : null,
        mail.attachments ? JSON.stringify(mail.attachments) : null,
        mail.read ?? false,
        mail.saved ?? false,
        mail.sent ?? false,
        mail.deleted ?? false,
        mail.draft ?? false,
        mail.insight ? JSON.stringify(mail.insight) : null,
        uid.domain ?? 0,
        uid.account ?? 0,
        hit._source.updated || new Date().toISOString(),
      ]);

      migrated++;
    } catch (error) {
      console.error(`  Error migrating mail ${hit._id}:`, error);
      skipped++;
    }
  }

  console.log(`  Migrated ${migrated} mails (skipped ${skipped}).`);
}

// Migrate push subscriptions
async function migratePushSubscriptions(userIdMap: UserIdMap): Promise<void> {
  const subHits = await fetchESDocuments("push_subscription");

  console.log("Migrating push subscriptions to PostgreSQL...");

  let migrated = 0;
  let skipped = 0;

  for (const hit of subHits) {
    const sub = hit._source.push_subscription || {};
    const docUser = (hit._source as unknown as Record<string, unknown>).user as
      | Record<string, unknown>
      | undefined;
    const esUserId = docUser?.id as string;

    const pgUserId = userIdMap[esUserId];

    if (!pgUserId) {
      skipped++;
      continue;
    }

    const keys = (sub.keys || {}) as Record<string, unknown>;

    const sql = `
      INSERT INTO push_subscriptions (
        push_subscription_id, user_id, endpoint, keys_p256dh, keys_auth, last_notified, updated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;

    await pgPool.query(sql, [
      crypto.randomUUID(),
      pgUserId,
      sub.endpoint || "",
      keys.p256dh || "",
      keys.auth || "",
      sub.lastNotified || null,
      hit._source.updated || new Date().toISOString(),
    ]);

    migrated++;
  }

  console.log(`  Migrated ${migrated} push subscriptions (skipped ${skipped}).`);
}

// Main migration function
async function migrate() {
  console.log("=".repeat(60));
  console.log("Elasticsearch → PostgreSQL Migration");
  console.log("Source: 192.168.0.32:9200, index: inbox-2");
  console.log("=".repeat(60));

  try {
    // Test ES connection
    const esInfo = await esClient.info();
    console.log(`ES cluster: ${esInfo.body.cluster_name}`);

    // Test PG connection
    const pgRes = await pgPool.query("SELECT NOW()");
    console.log(`PG connected at: ${pgRes.rows[0].now}`);

    // Drop existing tables for fresh schema
    await dropTables();

    // Create tables with new schema
    await createTables();

    // Migrate in order (users first due to foreign keys)
    const userIdMap = await migrateUsers();
    await migrateSessions(userIdMap);
    await migrateMails(userIdMap);
    await migratePushSubscriptions(userIdMap);

    console.log("\n" + "=".repeat(60));
    console.log("Migration completed successfully!");
    console.log("=".repeat(60));
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  } finally {
    await pgPool.end();
  }
}

migrate();
