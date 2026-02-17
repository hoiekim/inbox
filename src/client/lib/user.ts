import { LoginGetResponse } from "server";
import { call } from "./call";
import { getLocalStorageItem, setLocalStorageItem } from "./cache";

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
