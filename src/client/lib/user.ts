import { LoginGetResponse } from "server";
import { call, getLocalStorageItem, setLocalStorageItem } from "client";

export const callUser = () =>
  call.get<LoginGetResponse>("/api/users/login").then((r) => {
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
