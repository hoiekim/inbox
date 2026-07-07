import { Category } from "client";

export const getMailsQueryUrl = (account: string, category: Category) => {
  let queryOption: string;

  switch (category) {
    case Category.Search:
      return `/api/mails/search/${encodeURIComponent(account)}`;
    case Category.SpamMails:
      queryOption = "?spam=1";
      break;
    case Category.SentMails:
      queryOption = "?sent=1";
      break;
    case Category.NewMails:
      queryOption = "?new=1";
      break;
    case Category.SavedMails:
      queryOption = "?saved=1";
      break;
    default:
      queryOption = "";
  }

  return `/api/mails/headers/${account}${queryOption}`;
};
