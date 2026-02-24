import {
  getMailById,
  markMailRead,
  markMailSaved,
  deleteMail as pgDeleteMail,
} from "../postgres/repositories/mails";

/**
 * Authorization error thrown when a user attempts to access mail they don't own.
 */
export class MailAuthorizationError extends Error {
  constructor(message = "Mail not found or access denied") {
    super(message);
    this.name = "MailAuthorizationError";
  }
}

/**
 * Verify user owns the specified mail.
 * @throws {MailAuthorizationError} if mail doesn't exist or user doesn't own it
 */
const verifyOwnership = async (user_id: string, mail_id: string): Promise<void> => {
  const mail = await getMailById(user_id, mail_id);
  if (!mail) {
    throw new MailAuthorizationError();
  }
};

export const markRead = async (user_id: string, id: string) => {
  await verifyOwnership(user_id, id);
  return markMailRead(user_id, id);
};

export const markSaved = async (user_id: string, id: string, save: boolean) => {
  await verifyOwnership(user_id, id);
  return markMailSaved(user_id, id, save);
};

export const deleteMail = async (user_id: string, id: string) => {
  await verifyOwnership(user_id, id);
  return pgDeleteMail(user_id, id);
};
