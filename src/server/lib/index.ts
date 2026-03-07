// Logging (standalone, no dependencies)
export { logger } from "./logger";

// Shared utilities (domain helpers etc.) - no internal dependencies, safe to import anywhere.
// Pattern: export * from "./util" here so consumers can `import { getDomain } from "server"`
// without circular imports. Sub-modules that need these should also re-export via
// `export * from "../util"` in their own util.ts barrel.
export * from "./util";

// PostgreSQL database layer
export * from "./postgres";

// AI features
export * from "./ai";

// Push notifications (uses postgres internally)
export {
  getPushPublicKey,
  storeSubscription,
  deleteSubscription,
  cleanSubscriptions,
  getSubscriptions,
  refreshSubscription,
  notifyNewMails,
  decrementBadgeCount,
  getNotifications,
} from "./push";

// Mails module (uses postgres internally)
export {
  getMailHeaders,
  getMailBody,
  searchMail,
  markRead,
  markSaved,
  deleteMail,
  saveMailHandler,
  saveMail,
  convertMail,
  validateIncomingMail,
  addressToUsername,
  saveBuffer,
  getAccounts,
  getDomainUidNext,
  getAccountUidNext,
  getText,
  ATTACHMENT_FOLDER,
  getAttachmentId,
  getAttachmentFilePath,
  getAttachment,
  sendMail,
  validateMailData,
  MailValidationError,
  MailSendingError,
  getSpamHeaders,
  markSpam,
} from "./mails";
export type { AccountsGetResponse, GetMailsOptions, ValidationResult, SaveMailHandlerOptions } from "./mails";

// Spam filter
export * from "./spam";

// Version
export { version } from "./postgres/initialize";

// Users module
export * from "./users";

// Session store
export { PostgresSessionStore } from "./session";

// HTTP server
export * from "./http";

// IMAP server
export * from "./imap";

// SMTP server
export * from "./smtp";
