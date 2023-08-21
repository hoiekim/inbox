import { elasticsearchClient } from "server";
import { MailBodyData } from "common";

export const getMailBody = async (
  userId: string,
  mailId: string
): Promise<MailBodyData | undefined> => {
  type SearchReturn = Omit<MailBodyData, "id">;

  const mailBodyKeys: (keyof SearchReturn)[] = [
    "html",
    "attachments",
    "messageId",
    "insight"
  ];

  const response = await elasticsearchClient.search({
    _source: mailBodyKeys.map((k) => `mail.${k}`),
    query: {
      bool: {
        must: [{ term: { "user.id": userId } }, { term: { _id: mailId } }]
      }
    }
  });

  const hit = response.hits.hits[0];
  if (!hit) return;

  const { _id, _source } = hit;
  const mail = _source?.mail;
  return mail && new MailBodyData({ id: _id, ...mail });
};
