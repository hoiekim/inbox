import { PushSubscription } from "web-push";
import { PublicKeyGetResponse } from "server";
import { getLocalStorageItem, setLocalStorageItem } from "./cache";
import { call } from "client";
import {
  SubscribePostBody,
  SubscribePostResponse
} from "server/routes/push/post-subscribe";

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
      const publicKey = await call
        .get<PublicKeyGetResponse>("/api/push/public-key")
        .then(({ body }) => body);

      await navigator.serviceWorker.register("/service-worker.js");
      const registration = await navigator.serviceWorker.ready;

      const subscription = await registration.pushManager
        .subscribe({
          userVisibleOnly: true,
          applicationServerKey: publicKey
        })
        .then((s) => s as unknown as PushSubscription);

      const push_subscription_id = await call
        .post<SubscribePostResponse, SubscribePostBody>("/api/push/subscribe", {
          old_subscription_id: registered,
          subscription
        })
        .then(({ body }) => body);

      setLocalStorageItem("push_subscription_id", push_subscription_id);

      console.log("Subscribed to push notifications");
    } catch (error) {
      console.error("Error subscribing to push notifications:", error);
    }
  };
}
