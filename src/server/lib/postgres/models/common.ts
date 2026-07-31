// Table names
export const USERS = "users";
export const MAILS = "mails";
export const SESSIONS = "sessions";
export const PUSH_SUBSCRIPTIONS = "push_subscriptions";
export const SPAM_ALLOWLIST = "spam_allowlist";
export const SPAM_TRAINING = "spam_training";
export const MAIL_UID_COUNTERS = "mail_uid_counters";
export const MAIL_MAILBOX_UID = "mail_mailbox_uid";

// Columns on mail_mailbox_uid. `mailbox` holds the full IMAP path (INBOX,
// Sent Messages, INBOX/accounts/<name>, and any future user-defined path).
export const MAILBOX = "mailbox";
export const UID = "uid";

// Common column names
export const UPDATED = "updated";
export const IS_DELETED = "is_deleted";

// Users columns
export const USER_ID = "user_id";
export const USERNAME = "username";
export const PASSWORD = "password";
export const EMAIL = "email";
export const TOKEN = "token";
export const EXPIRY = "expiry";
export const IMAP_UID_VALIDITY = "imap_uid_validity";

// Mails columns
export const MAIL_ID = "mail_id";
export const MESSAGE_ID = "message_id";
export const SUBJECT = "subject";
export const DATE = "date";
export const HTML = "html";
export const TEXT = "text";
export const FROM_ADDRESS = "from_address";
export const FROM_TEXT = "from_text";
export const TO_ADDRESS = "to_address";
export const TO_TEXT = "to_text";
export const CC_ADDRESS = "cc_address";
export const CC_TEXT = "cc_text";
export const BCC_ADDRESS = "bcc_address";
export const BCC_TEXT = "bcc_text";
export const REPLY_TO_ADDRESS = "reply_to_address";
export const REPLY_TO_TEXT = "reply_to_text";
export const ENVELOPE_FROM = "envelope_from";
export const ENVELOPE_TO = "envelope_to";
export const ATTACHMENTS = "attachments";
export const READ = "read";
export const SAVED = "saved";
export const SENT = "sent";
export const DELETED = "deleted";
export const DRAFT = "draft";
export const ANSWERED = "answered";
export const EXPUNGED = "expunged";
export const INSIGHT = "insight";
export const UID_DOMAIN = "uid_domain";
// Per-message mod-sequence for CONDSTORE (RFC 7162). Monotonically increasing
// within a mailbox. Bumped by the IMAP write paths — new-message insert
// (saveMail, incl. APPEND/COPY), STORE (setMailFlags), and EXPUNGE/MOVE.
// The web-REST single-mail mutators (markMailRead / markMailSaved / markMailSpam)
// deliberately do NOT bump it in phase 1: no client can observe modseq until
// phase 3 (FETCH CHANGEDSINCE) lands, so there is no reader to desync. That
// wiring is a phase-3 task — see the CONDSTORE phase-3 issue.
export const MODSEQ = "modseq";
// mail_uid_counters columns
export const UID_KIND = "uid_kind";
export const UID_SCOPE = "uid_scope";
export const LAST_UID = "last_uid";
export const SPAM_SCORE = "spam_score";
export const SPAM_REASONS = "spam_reasons";
export const IS_SPAM = "is_spam";
// Cached byte count of the mail's serialized RFC 822 form. Populated
// lazily on the first FETCH that requests RFC822.SIZE (or an equivalent
// full-body derivation) and never invalidated — mail body content
// (text/html/attachments/headers) is immutable after insert, so the
// size is a stable derived value. `NULL` means "not yet computed";
// readers fall back to the on-the-fly `buildFullMessage` compute and
// persist the result. Motivates: avoid materializing multi-MB
// attachments per RFC822.SIZE request. See #729.
export const RFC822_SIZE = "rfc822_size";
// Cached line counts of the mail's `text` / `html` columns, matching the
// RFC 3501 §7.4.2 BODYSTRUCTURE `lines` field (`content.split(/\r?\n/).length`
// on the raw column). Populated at INSERT time from the incoming body strings
// (cheap: one split each) and lazily backfilled on read for pre-existing
// rows. `NULL` means "not yet computed"; readers fall back to loading the
// text/html columns to compute + persist. Motivates: BODYSTRUCTURE's `lines`
// field was the last text/html materialization gap after #731 / #739 — a
// bare `UID FETCH X BODYSTRUCTURE` batch was still loading multi-MB
// text/html per UID to derive `lines`, spiking RSS. See the 2026-07-31 07:54
// + 09:17 UTC OOMs.
export const TEXT_LINE_COUNT = "text_line_count";
export const HTML_LINE_COUNT = "html_line_count";

// Sessions columns
export const SESSION_ID = "session_id";
export const SESSION_USER_ID = "session_user_id";
export const SESSION_USERNAME = "session_username";
export const SESSION_EMAIL = "session_email";
export const COOKIE_ORIGINAL_MAX_AGE = "cookie_original_max_age";
export const COOKIE_MAX_AGE = "cookie_max_age";
export const COOKIE_SIGNED = "cookie_signed";
export const COOKIE_EXPIRES = "cookie_expires";
export const COOKIE_HTTP_ONLY = "cookie_http_only";
export const COOKIE_PATH = "cookie_path";
export const COOKIE_DOMAIN = "cookie_domain";
export const COOKIE_SECURE = "cookie_secure";
export const COOKIE_SAME_SITE = "cookie_same_site";

// Push subscriptions columns
export const PUSH_SUBSCRIPTION_ID = "push_subscription_id";
export const ENDPOINT = "endpoint";
export const KEYS_P256DH = "keys_p256dh";
export const KEYS_AUTH = "keys_auth";
export const LAST_NOTIFIED = "last_notified";

// SQL NULL
export const NULL = "NULL";
