import { getLocalStorageItem, setLocalStorageItem } from "./cache";

export class Notifier {
  constructor() {
    if ("setAppBadge" in navigator && "clearAppBadge" in navigator) {
      this.isBadgeAvailable = true;
    }
    if (
      "Notification" in window &&
      "serviceWorker" in navigator &&
      "PushManager" in window
    ) {
      this.isNotificationAvailable = true;
    }
  }

  private isBadgeAvailable = false;
  private isNotificationAvailable = false;

  setBadge = (number: number) => {
    if (!this.isBadgeAvailable) return;
    (navigator as any).setAppBadge(number).catch(console.log);
  };

  clearBadge = () => {
    if (!this.isBadgeAvailable) return;
    (navigator as any).clearAppBadge().catch(console.log);
  };

  requestPermission = () => {
    if (!this.isNotificationAvailable) return;
    return Notification.requestPermission();
  };

  notify = (arg: { title: string; body?: string; icon?: string }) => {
    if (!this.isNotificationAvailable) return;
    const { title, body, icon } = arg;
    const options = { body, icon };
    new Notification(title, options);
  };

  subscribe = async () => {
    if (!this.isNotificationAvailable) return;
    if (Notification.permission !== "granted") return;

    const registered = getLocalStorageItem("push_subscription_id");

    try {
      const publicKey = await fetch("/push/publicKey")
        .then((r) => r.json())
        .then((r) => r.publicKey);

      await navigator.serviceWorker.register("/service-worker.js");
      const registration = await navigator.serviceWorker.ready;

      const subsPromise = registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: publicKey
      });

      const subscription = await subsPromise;

      const { push_subscription_id } = await fetch("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          oldSubscriptionId: registered,
          subscription
        })
      }).then((r) => r.json());

      setLocalStorageItem("push_subscription_id", push_subscription_id);

      console.log("Subscribed to push notifications");
    } catch (error) {
      console.error("Error subscribing to push notifications:", error);
    }
  };
}
