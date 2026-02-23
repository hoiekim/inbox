import { SignedUser } from "common";
import { getUnreadNotifications } from "../postgres/repositories/mails";

export type Notifications = Map<string, { count: number; latest?: Date }>;

export const getNotifications = async (
  users: SignedUser[]
): Promise<Notifications> => {
  const notifications: Notifications = new Map(
    users.map((u) => [u.username, { count: 0 }])
  );

  const userIds = users.map((u) => u.id);
  const rawNotifications = await getUnreadNotifications(userIds);

  // Map user IDs back to usernames
  for (const user of users) {
    const data = rawNotifications.get(user.id);
    if (data) {
      notifications.set(user.username, data);
    }
  }

  return notifications;
};
