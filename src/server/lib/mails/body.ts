import { MailBodyData, elasticsearchClient, index } from "server";

export const getMailBody = async (
  userId: string,
  mailId: string
): Promise<MailBodyData> => {
  type SearchReturn = Omit<MailBodyData, "id">;

  const mailBodyKeys: (keyof SearchReturn)[] = [
    "html",
    "attachments",
    "messageId",
    "insight"
  ];

  const response = await elasticsearchClient.search<SearchReturn>({
    index,
    _source: mailBodyKeys,
    query: {
      bool: {
        must: [{ term: { "user.id": userId } }, { term: { _id: mailId } }]
      }
    }
  });

  const { _id, _source } = response.hits.hits[0];
  const source = _source as SearchReturn;
  return { id: _id, ...source };
};
