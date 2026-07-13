/**
 * Spam-related mail operations
 */

import { markMailSpam } from "../postgres/repositories/mails";

/**
 * Mark or unmark a mail as spam.
 * Authorization is enforced at the repository layer via user_id in WHERE clause.
 */
export const markSpam = async (
  user_id: string,
  mail_id: string,
  is_spam: boolean
): Promise<{ found: boolean; changed: boolean }> => {
  return markMailSpam(user_id, mail_id, is_spam);
};
