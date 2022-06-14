export class Notifier {
  constructor() {
    if ("setAppBadge" in navigator && "clearAppBadge" in navigator) {
      this.isNavigatorAvailable = true;
    }
    if (
      "Notification" in window &&
      "serviceWorker" in navigator &&
      "PushManager" in window
    ) {
      this.isNotificationAvailable = true;
    }
  }

  private isNavigatorAvailable = false;
  private isNotificationAvailable = false;

  setBadge = (number: number) => {
    if (!this.isNavigatorAvailable) return;
    (navigator as any).setAppBadge(number).catch(console.log);
  };

  clearBadge = () => {
    if (!this.isNavigatorAvailable) return;
    (navigator as any).clearAppBadge().catch(console.log);
  };

  requestPermission = () => {
    if (!this.isNotificationAvailable) return;
    Notification.requestPermission();
  };

  notify = (arg: { title: string; body?: string; icon?: string }) => {
    if (!this.isNotificationAvailable) return;
    const { title, body, icon } = arg;
    const options = { body, icon };
    new Notification(title, options);
  };
}
