import { MailBodyData } from "common";
import { getMailById } from "../postgres/repositories/mails";

export const getMailBody = async (
  userId: string,
  mailId: string
): Promise<MailBodyData | undefined> => {
  const mailModel = await getMailById(userId, mailId);

  if (!mailModel) return undefined;

  return new MailBodyData({
    id: mailModel.mail_id,
    html: mailModel.html,
    attachments: mailModel.attachments as any,
    messageId: mailModel.message_id,
    insight: mailModel.insight as any,
  });
};
