import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, callUser } from "client";

import "./index.scss";

// Report unhandled JS errors to server
window.addEventListener("error", (event) => {
  const body = JSON.stringify({
    message: event.message,
    stack: event.error?.stack ?? "",
    url: window.location.href,
  });
  navigator.sendBeacon("/api/client-error", new Blob([body], { type: "application/json" }));
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  const body = JSON.stringify({
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? (reason.stack ?? "") : "",
    url: window.location.href,
  });
  navigator.sendBeacon("/api/client-error", new Blob([body], { type: "application/json" }));
});

// Register the service worker on every page load so the cache-first
// /assets/* tier inside service-worker.js is always active — keeps the
// app working on stale tabs after a deploy rewrites the hashed chunk
// filenames in index.html (#501). The push-notification subscribe flow
// in client/lib/notification.ts no-ops `register()` after the first
// call, so this doesn't change anything for already-subscribed users.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch((error) => {
      console.error("Service worker registration failed:", error);
    });
  });
}

const root = createRoot(document.getElementById("root") as HTMLElement);

const mountApp = async () => {
  const user = await callUser();
  root.render(
    <StrictMode>
      <App user={user} />
    </StrictMode>
  );
};

mountApp();
