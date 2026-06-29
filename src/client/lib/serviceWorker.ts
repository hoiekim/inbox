/**
 * Service-worker lifecycle for the IndexedDB-cache rollout (Phase 2, #458).
 *
 * `public/service-worker.js` precaches the SPA shell, serves hashed `/assets/*`
 * cache-first, and falls back to the cached shell for offline navigations.
 * Until now it was registered only as a side effect of opting in to push
 * (`Notifier.subscribe`, which bails unless notification permission is granted),
 * so users who never enabled notifications got none of the offline/asset-cache
 * benefit. Register it for every authenticated session instead, and tear it
 * down on logout so a shared browser never serves the previous user's cached
 * shell.
 */

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
 * Pairs with `clearCachedQueries()` (the IndexedDB query-cache clear) at the
 * logout site.
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
