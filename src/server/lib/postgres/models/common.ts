// Table names
export const USERS = "users";
export const MAILS = "mails";
export const SESSIONS = "sessions";
export const PUSH_SUBSCRIPTIONS = "push_subscriptions";
export const SPAM_ALLOWLIST = "spam_allowlist";

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
export const UID_ACCOUNT = "uid_account";
export const SPAM_SCORE = "spam_score";
export const SPAM_REASONS = "spam_reasons";
export const IS_SPAM = "is_spam";

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
