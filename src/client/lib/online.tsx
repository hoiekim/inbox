import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode
} from "react";

import { queryClient } from "./queryClient";
import { matchCacheCatalog } from "./cacheCatalog";

export interface OnlineState {
  isOnline: boolean;
  /** ms-epoch of the last moment the server was reachable, or null if never. */
  lastSeenOnline: number | null;
}

export interface IsOnlineContextValue extends OnlineState {
  /** Force an immediate heartbeat (the banner's "Retry" button). */
  recheck: () => void;
}

const HEARTBEAT_MS = 30 * 1000;

/**
 * Pure state transition. Returns the next state plus whether this is an
 * offline→online edge (the only moment we want to refetch). Kept side-effect
 * free so the reconnect rule is unit-testable without React or timers.
 */
export const reduceOnline = (
  prev: OnlineState,
  online: boolean,
  now: number
): { state: OnlineState; reconnected: boolean } => ({
  state: {
    isOnline: online,
    lastSeenOnline: online ? now : prev.lastSeenOnline
  },
  reconnected: online && !prev.isOnline
});

/**
 * Hit the liveness endpoint and report reachability. `fetchImpl` is injectable
 * so the heartbeat can be tested without a real network. Any throw (DNS
 * failure, abort, offline) is reachability=false, never a rejection.
 */
export const pingHealth = async (
  fetchImpl: typeof fetch = fetch
): Promise<boolean> => {
  try {
    const res = await fetchImpl("/api/ping", { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
};

/**
 * Refetch every React Query whose key is a cacheable endpoint (per the single
 * cache catalog). Called on the offline→online edge so the stale data the user
 * was shown while offline is replaced as soon as the server is reachable again.
 */
export const invalidateCacheableQueries = (client = queryClient): void => {
  client.invalidateQueries({
    predicate: (query) => {
      const key = Array.isArray(query.queryKey)
        ? query.queryKey[0]
        : query.queryKey;
      return typeof key === "string" && !!matchCacheCatalog(key);
    }
  });
};

/**
 * Render the "data as of" clock for the offline banner. Returns a local
 * `HH:MM` string, or a dash when the server was never reached this session.
 */
export const formatLastSeen = (lastSeenOnline: number | null): string => {
  if (lastSeenOnline == null) return "—";
  return new Date(lastSeenOnline).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
};

/**
 * Is the data a query is currently rendering older than the last thing that
 * happened to that query? True exactly when a fetch has failed and no
 * successful one has landed since — including after an optimistic
 * `setQueryData`, which clears `error` but leaves `errorUpdatedAt` standing
 * (and, via `QueryCache.set`, carries `dataUpdatedAt` forward). Reading the
 * two stamps rather than `error` is what keeps the signal alive across a local
 * edit made while the server is unreachable.
 */
export const isShowingStaleData = (query: {
  dataUpdatedAt: number;
  errorUpdatedAt: number;
}): boolean => query.errorUpdatedAt > query.dataUpdatedAt;

/**
 * Render the "as of" clock for cached data, which — unlike the banner's
 * session-scoped `lastSeenOnline` — can be up to `maxAgeMs` old (a week for the
 * header catalog). A bare `HH:MM` on week-old data reads as today, so anything
 * fetched before `now`'s calendar day carries its date.
 */
export const formatDataAge = (
  dataUpdatedAt: number,
  now: number = Date.now()
): string => {
  const fetched = new Date(dataUpdatedAt);
  const time = fetched.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
  if (fetched.toDateString() === new Date(now).toDateString()) return time;
  return `${fetched.toLocaleDateString([], {
    month: "short",
    day: "numeric"
  })} ${time}`;
};

const IsOnlineContext = createContext<IsOnlineContextValue>({
  isOnline: true,
  lastSeenOnline: null,
  recheck: () => {}
});

export const IsOnlineProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<OnlineState>(() => {
    const online = navigator.onLine;
    return { isOnline: online, lastSeenOnline: online ? Date.now() : null };
  });

  // Mirror of `state.isOnline` readable synchronously so the reconnect side
  // effect fires outside the (StrictMode-double-invoked) state updater.
  const isOnlineRef = useRef(state.isOnline);

  const apply = useCallback((online: boolean) => {
    const wasOnline = isOnlineRef.current;
    isOnlineRef.current = online;
    setState((prev) => reduceOnline(prev, online, Date.now()).state);
    if (online && !wasOnline) invalidateCacheableQueries();
  }, []);

  const recheck = useCallback(() => {
    pingHealth().then(apply);
  }, [apply]);

  useEffect(() => {
    const handleOnline = () => apply(true);
    const handleOffline = () => apply(false);
    const handleVisible = () => {
      if (document.visibilityState === "visible") recheck();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisible);

    const interval = setInterval(() => {
      // Don't ping a backgrounded tab — the heartbeat exists to keep the
      // visible UI honest, not to poll forever in the background.
      if (document.visibilityState === "visible") recheck();
    }, HEARTBEAT_MS);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisible);
      clearInterval(interval);
    };
  }, [apply, recheck]);

  return (
    <IsOnlineContext.Provider value={{ ...state, recheck }}>
      {children}
    </IsOnlineContext.Provider>
  );
};

export const useIsOnline = (): IsOnlineContextValue =>
  useContext(IsOnlineContext);
