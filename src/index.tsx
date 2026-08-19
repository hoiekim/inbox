import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  App,
  callUser,
  hydrateQueryCache,
  setCacheUser,
  startCachePersistence,
} from "client";

import "./index.scss";

// Report unhandled JS errors to server
window.addEventListener("error", (event) => {
  // The browser sanitizes `message` to "Script error." and nulls `error` when
  // the throw came from a cross-origin script (browser extension, CDN chunk).
  // `filename`/`lineno`/`colno` survive that sanitization for same-origin code
  // and expose the extension/CDN URL for cross-origin code, so an otherwise
  // opaque report still says where it came from.
  const body = JSON.stringify({
    message: event.message,
    stack: event.error?.stack ?? "",
    url: window.location.href,
    filename: event.filename || undefined,
    lineno: event.lineno || undefined,
    colno: event.colno || undefined,
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
  setCacheUser(user?.id);
  await hydrateQueryCache(user?.id);
  startCachePersistence();
  root.render(
    <StrictMode>
      <App user={user} />
    </StrictMode>
  );
};

mountApp();
