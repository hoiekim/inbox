import {
  markMailRead,
  markMailSaved,
  deleteMail as pgDeleteMail,
} from "../postgres/repositories/mails";

/**
 * Mail update operations.
 * Authorization is enforced at the repository layer via user_id in WHERE clauses.
 */

export const markRead = async (user_id: string, id: string) => {
  return markMailRead(user_id, id);
};

export const markSaved = async (user_id: string, id: string, save: boolean) => {
  return markMailSaved(user_id, id, save);
};

export const deleteMail = async (user_id: string, id: string) => {
  return pgDeleteMail(user_id, id);
};
