-- inbox #725: backfill mail_mailbox_uid pivot rows for existing saved / deleted mails.
--
-- Runs once, after the code lands, to make the new Starred / Trash IMAP mailboxes
-- reflect the mails users have already saved (mails.saved = TRUE) and deleted
-- (mails.deleted = TRUE) via the web client, POST /mark, or a legacy IMAP client.
-- Without this the two boxes ship empty and only new stars/deletes populate them.
--
-- Idempotent: the pivot INSERT uses ON CONFLICT DO NOTHING keyed on
-- (user_id, mailbox, mail_id), and the counter seed uses GREATEST() over the
-- existing row. Re-runs are safe and cheap. A live star that happens between
-- the pivot insert and the counter seed collides only on the counter row; the
-- live path's atomic reservation still returns a distinct value.
--
-- Sent-mail note: the pivot INSERT covers sent-starred / sent-deleted mails
-- too. The IMAP read side today JOINs mails and filters sent = FALSE, so those
-- pivots are DEAD ROWS until the sent-axis refactor lands (follow-up). Keeping
-- them here means the refactor becomes purely a query change — no extra
-- backfill pass over pre-existing sent-starred mail.
--
-- Ordering: UIDs are assigned in (date ASC, mail_id ASC) so the client's
-- initial sync of Starred / Trash matches the chronological order the web
-- surfaces already show. mail_id is the tiebreaker for mails with identical
-- timestamps.

BEGIN;

WITH starred_rows AS (
  SELECT
    user_id,
    mail_id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY date ASC, mail_id ASC
    ) AS uid
  FROM mails
  WHERE saved = TRUE
)
INSERT INTO mail_mailbox_uid (user_id, mailbox, mail_id, uid)
SELECT user_id, 'Starred', mail_id, uid
FROM starred_rows
ON CONFLICT (user_id, mailbox, mail_id) DO NOTHING;

WITH trash_rows AS (
  SELECT
    user_id,
    mail_id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY date ASC, mail_id ASC
    ) AS uid
  FROM mails
  WHERE deleted = TRUE
)
INSERT INTO mail_mailbox_uid (user_id, mailbox, mail_id, uid)
SELECT user_id, 'Trash', mail_id, uid
FROM trash_rows
ON CONFLICT (user_id, mailbox, mail_id) DO NOTHING;

-- Seed / advance the per-mailbox counter to MAX(uid). Live post-backfill
-- reservations take the DO UPDATE branch and add 1, so the next reservation
-- for Starred/Trash starts at MAX(uid) + 1 — no risk of duplicating a
-- backfilled UID. GREATEST() protects against a race where a live star bumped
-- the counter past the backfilled MAX between the pivot insert and the
-- counter seed.
INSERT INTO mail_uid_counters (user_id, uid_kind, uid_scope, sent, last_uid)
SELECT
  user_id,
  'mailbox' AS uid_kind,
  mailbox   AS uid_scope,
  FALSE     AS sent,
  MAX(uid)  AS last_uid
FROM mail_mailbox_uid
WHERE mailbox IN ('Starred', 'Trash')
GROUP BY user_id, mailbox
ON CONFLICT (user_id, uid_kind, uid_scope, sent) DO UPDATE
SET last_uid = GREATEST(mail_uid_counters.last_uid, EXCLUDED.last_uid);

-- Sanity: report the counts so the operator can eyeball them.
SELECT
  mailbox,
  COUNT(*) AS pivot_rows,
  MAX(uid) AS max_uid
FROM mail_mailbox_uid
WHERE mailbox IN ('Starred', 'Trash')
GROUP BY mailbox
ORDER BY mailbox;

COMMIT;
