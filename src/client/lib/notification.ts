import { PushSubscription } from "web-push";
import { PublicKeyGetResponse, RefreshGetResponse } from "server";
import { call, getLocalStorageItem, setLocalStorageItem } from "client";
import { SubscribePostBody, SubscribePostResponse } from "server";

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
    (navigator as any).setAppBadge(number).catch(console.error);
  };

  clearBadge = () => {
    if (!this.isBadgeAvailable) return;
    (navigator as any).clearAppBadge().catch(console.error);
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

    await navigator.serviceWorker.register("/service-worker.js");
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();

    const savedSubscriptionId = getLocalStorageItem("push_subscription_id");

    if (existing && savedSubscriptionId) {
      const apiPath = "/api/push/refresh/" + savedSubscriptionId;
      const refreshResult = await call.get<RefreshGetResponse>(apiPath);
      if (refreshResult.status === "success") return;
    }

    existing?.unsubscribe();
    setLocalStorageItem("push_subscription_id", undefined);

    try {
      const applicationServerKey = await call
        .get<PublicKeyGetResponse>("/api/push/public-key")
        .then(({ body }) => body);

      const subscription = await registration.pushManager
        .subscribe({ userVisibleOnly: true, applicationServerKey })
        .then((s) => s as unknown as PushSubscription);

      const callPost = call.post<SubscribePostResponse, SubscribePostBody>;
      const apiPath = "/api/push/subscribe";
      const postResult = await callPost(apiPath, { subscription });
      const { body: newSubscriptionId } = postResult;

      setLocalStorageItem("push_subscription_id", newSubscriptionId);

      console.log("Subscribed to push notifications");
    } catch (error) {
      console.error("Error subscribing to push notifications:", error);
    }
  };
}
