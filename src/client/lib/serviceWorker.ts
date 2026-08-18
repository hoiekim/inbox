
const SW_URL = "/service-worker.js";

/**
 * Register the SW for an authenticated session. Idempotent and safe to call on
 * every auth resolve — the browser dedups registration by script URL. No-ops
 * where the API is unavailable (older browsers, insecure origins).
 */
export const registerServiceWorker = async (): Promise<void> => {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register(SW_URL);
  } catch (error) {
    console.error("Service worker registration failed:", error);
  }
};

/**
 * Tear down the SW and every Cache Storage entry on logout so the next user on
 * this browser can't be served the previous user's cached shell or asset set.
 * `unregister()` stops the worker from controlling *future* loads; the active
 * worker keeps controlling the current document until the next navigation. That
 * gap is harmless here because Cache Storage is already emptied below, so the
 * still-active worker falls through to the network. Pairs with
 * `clearCachedQueries()` (the IndexedDB query-cache clear) at the logout site.
 */
export const unregisterServiceWorker = async (): Promise<void> => {
  if ("serviceWorker" in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((r) => r.unregister()));
    } catch (error) {
      console.error("Service worker unregister failed:", error);
    }
  }
  if (typeof caches !== "undefined") {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch (error) {
      console.error("Cache storage clear failed:", error);
    }
  }
};
