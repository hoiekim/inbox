import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LoginGetResponse } from "server";
import { App, getLocalStorageItem, setLocalStorageItem, call } from "client";

import "./index.scss";

const root = createRoot(document.getElementById("root") as HTMLElement);

const mountApp = async () => {
  const user = await call
    .get<LoginGetResponse>("/api/users/login")
    .then((r) => {
      const app = r.body?.app;
      const version = app?.version;
      if (version) {
        const appInfo = getLocalStorageItem("app");
        const theVersionThatIUsedToKnow = appInfo?.version;
        if (theVersionThatIUsedToKnow !== version) {
          localStorage.clear();
          setLocalStorageItem("app", app);
        }
      }
      return r.body?.user;
    });

  root.render(
    <StrictMode>
      <App user={user} />
    </StrictMode>
  );
};

mountApp();
