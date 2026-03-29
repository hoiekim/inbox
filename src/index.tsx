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
