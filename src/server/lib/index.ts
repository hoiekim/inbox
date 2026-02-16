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
  getDomain,
  getText,
  getUserDomain,
  ATTACHMENT_FOLDER,
  getAttachmentId,
  getAttachmentFilePath,
  getAttachment,
  sendMail,
} from "./mails";
export type { AccountsGetResponse, GetMailsOptions } from "./mails";

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
