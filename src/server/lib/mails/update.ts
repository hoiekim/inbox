import {
  markMailRead,
  markMailSaved,
  deleteMail as pgDeleteMail,
} from "../postgres/repositories/mails";

/**
 * Mail update operations.
 * Note: Authentication and authorization are handled at the HTTP route layer
 * (see routes/mails/post-mark.ts and routes/mails/delete.ts).
 */

export const markRead = async (id: string) => {
  return markMailRead(id);
};

export const markSaved = async (id: string, save: boolean) => {
  return markMailSaved(id, save);
};

export const deleteMail = async (id: string) => {
  return pgDeleteMail(id);
};
