-- Migration: Add UNIQUE constraint on (user_id, message_id) for mails table
-- This prevents duplicate emails from being saved for the same user.
--
-- IMPORTANT: Run this migration ONCE after deploying the code change.
-- The application code now uses INSERT ... ON CONFLICT DO NOTHING to handle
-- potential duplicates gracefully.

-- Step 1: De-duplicate existing data (keep the first occurrence by mail_id)
-- This creates a temp table with IDs to keep
CREATE TEMP TABLE mails_to_keep AS
SELECT DISTINCT ON (user_id, message_id) mail_id
FROM mails
ORDER BY user_id, message_id, mail_id;

-- Step 2: Delete duplicates (rows not in the keep list)
DELETE FROM mails
WHERE mail_id NOT IN (SELECT mail_id FROM mails_to_keep);

-- Step 3: Drop the temp table
DROP TABLE mails_to_keep;

-- Step 4: Add the UNIQUE constraint
-- This will fail if duplicates still exist (shouldn't happen after step 2)
ALTER TABLE mails
ADD CONSTRAINT mails_user_message_unique UNIQUE (user_id, message_id);

-- Verify the constraint was added
SELECT conname, contype 
FROM pg_constraint 
WHERE conrelid = 'mails'::regclass 
  AND conname = 'mails_user_message_unique';
