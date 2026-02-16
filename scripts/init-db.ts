/**
 * Initialize PostgreSQL database tables (minimal version)
 * Usage: POSTGRES_USER=hoiekim npx ts-node scripts/init-db.ts
 */

import { Pool, types } from "pg";

const pool = new Pool({
  host: process.env.POSTGRES_HOST || "localhost",
  port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
  user: process.env.POSTGRES_USER || "hoiekim",
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

async function main() {
  console.log("Initializing PostgreSQL database tables...");

  // Users table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id UUID PRIMARY KEY,
      username VARCHAR(255) NOT NULL UNIQUE,
      password VARCHAR(255),
      email VARCHAR(255),
      expiry TIMESTAMPTZ,
      token VARCHAR(255),
      updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      is_deleted BOOLEAN DEFAULT FALSE
    )
  `);
  console.log("  Created users table");

  // Sessions table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id VARCHAR(255) PRIMARY KEY,
      session_user_id UUID REFERENCES users(user_id),
      session_username VARCHAR(255),
      session_email VARCHAR(255),
      cookie_original_max_age INTEGER,
      cookie_max_age INTEGER,
      cookie_signed BOOLEAN,
      cookie_expires TIMESTAMPTZ,
      cookie_http_only BOOLEAN,
      cookie_path VARCHAR(255),
      cookie_domain VARCHAR(255),
      cookie_secure VARCHAR(255),
      cookie_same_site VARCHAR(255),
      updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log("  Created sessions table");

  // Mails table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mails (
      mail_id UUID PRIMARY KEY,
      user_id UUID REFERENCES users(user_id),
      message_id VARCHAR(255) NOT NULL,
      subject TEXT,
      date TIMESTAMPTZ,
      html TEXT,
      text TEXT,
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
      attachments JSONB,
      read BOOLEAN DEFAULT FALSE,
      saved BOOLEAN DEFAULT FALSE,
      sent BOOLEAN DEFAULT FALSE,
      deleted BOOLEAN DEFAULT FALSE,
      draft BOOLEAN DEFAULT FALSE,
      insight JSONB,
      uid_domain INTEGER DEFAULT 0,
      uid_account INTEGER DEFAULT 0,
      updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      search_vector TSVECTOR
    )
  `);
  console.log("  Created mails table");

  // Push subscriptions table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      push_subscription_id UUID PRIMARY KEY,
      user_id UUID REFERENCES users(user_id),
      endpoint TEXT NOT NULL,
      keys_p256dh TEXT,
      keys_auth TEXT,
      last_notified TIMESTAMPTZ,
      updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log("  Created push_subscriptions table");

  // Indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mails_user_id ON mails(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mails_search ON mails USING GIN(search_vector)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(session_user_id)`);
  console.log("  Created indexes");

  // Search vector trigger
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
  await pool.query(`DROP TRIGGER IF EXISTS mails_search_update ON mails`);
  await pool.query(`
    CREATE TRIGGER mails_search_update 
      BEFORE INSERT OR UPDATE ON mails 
      FOR EACH ROW EXECUTE FUNCTION mails_search_vector_trigger()
  `);
  console.log("  Created search trigger");

  console.log("Done!");
  await pool.end();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
