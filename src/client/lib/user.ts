import { LoginGetResponse } from "server";
import { call } from "./call";
import { getLocalStorageItem, setLocalStorageItem } from "./cache";
import { idbClearQueries } from "./idbStore";

export const callUser = () =>
  call.get<LoginGetResponse>("/api/users/login").then(async (r) => {
    const app = r.body?.app;
    const version = app?.version;
    if (version) {
      const appInfo = getLocalStorageItem("app");
      const theVersionThatIUsedToKnow = appInfo?.version;
      if (theVersionThatIUsedToKnow !== version) {
        localStorage.clear();
        // A new deploy can change cached payload shapes; drop the IndexedDB
        // query cache too so hydration can't seed a stale-schema response.
        // Awaited so the purge completes before mountApp's hydrate reads it.
        await idbClearQueries();
        setLocalStorageItem("app", app);
      }
    }
    return r.body?.user;
  });
