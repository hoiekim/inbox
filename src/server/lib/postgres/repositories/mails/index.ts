// Mails repository, split by server component (issue #700):
//   - core: per-mail CRUD (save / get / mark / delete / spam) shared across
//     the SMTP receive, send, and HTTP paths.
//   - counters: atomic UID + mod-sequence reservation (mail_uid_counters).
//   - http: the web-app read/query surface (headers, delta, search, per-account
//     stats, unread notifications).
//   - imap: IMAP protocol operations (count, range FETCH, STORE flags, SEARCH,
//     UID enumeration, EXPUNGE).
//   - views: which rows each mailbox contains and which UID space it
//     enumerates, shared by counters and imap.
export * from "./core";
export * from "./counters";
export * from "./http";
export * from "./imap";
export * from "./views";
