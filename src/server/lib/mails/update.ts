import { elasticsearchClient, index } from "server";

// TODO: authentication
export const markRead = (id: string) => {
  return elasticsearchClient.update({
    index,
    id,
    doc: { mail: { read: true } }
  });
};

// TODO: authentication
export const markSaved = (id: string, save: boolean) => {
  console.log(id, save);
  return elasticsearchClient.update({
    index,
    id,
    doc: { mail: { saved: save } }
  });
};

// TODO: authentication
export const deleteMail = (id: string) => {
  return elasticsearchClient.delete({ index, id });
};
