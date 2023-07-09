import { elasticsearchClient, index } from "server";

export const markRead = (id: string) => {
  return elasticsearchClient.update({
    index,
    id,
    doc: { read: true }
  });
};

export const markSaved = (id: string, save: boolean) => {
  return elasticsearchClient.update({
    index,
    id,
    doc: { label: save ? "saved" : null }
  });
};

export const deleteMail = (id: string) => {
  return elasticsearchClient.delete({ index, id });
};
