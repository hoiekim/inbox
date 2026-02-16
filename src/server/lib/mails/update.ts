import {
  markMailRead,
  markMailSaved,
  deleteMail as pgDeleteMail,
} from "../postgres/repositories/mails";

// TODO: authentication
export const markRead = async (id: string) => {
  return markMailRead(id);
};

// TODO: authentication
export const markSaved = async (id: string, save: boolean) => {
  return markMailSaved(id, save);
};

// TODO: authentication
export const deleteMail = async (id: string) => {
  return pgDeleteMail(id);
};
