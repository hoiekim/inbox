self.addEventListener("push", (event) => {
  if (!event.data) return;

  const notification = event.data.json();
  if (!notification) return;

  const { push_subscription_id, title, icon, badge_count } = notification;

  const showNotification = async () => {
    if (!title) return;
    return self.registration.showNotification(title, { icon });
  };

  const setBadge = async () => {
    if (badge_count === undefined) return;
    if (badge_count === 0) self.navigator.clearAppBadge();
    else self.navigator.setAppBadge(badge_count);
  };

  const refresh = () => fetch("/api/push/refresh/" + push_subscription_id);

  const jobs = Promise.all([showNotification(), setBadge(), refresh()]);

  event.waitUntil(jobs);
});
