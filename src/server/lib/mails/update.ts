import {
  markMailRead,
  markMailSaved,
  deleteMail as pgDeleteMail,
} from "../postgres/repositories/mails";

// TODO: These functions accept only mail_id without user_id, so they rely on
// the caller (HTTP routes) to verify ownership first. Consider adding user_id
// parameter and ownership check here for defense in depth.

export const markRead = async (id: string) => {
  return markMailRead(id);
};

export const markSaved = async (id: string, save: boolean) => {
  return markMailSaved(id, save);
};

export const deleteMail = async (id: string) => {
  return pgDeleteMail(id);
};
