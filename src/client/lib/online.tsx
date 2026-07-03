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

/**
 * Phase 2 (#458) offline-read UX. Tracks whether the app can currently reach
 * the server and exposes that as a single shared signal so the offline banner —
 * and, in a later #458 slice, every mutating control — read one source of truth
 * instead of each running its own `navigator.onLine` check + heartbeat.
 *
 * Two signals feed the state, in increasing order of trust:
 *   1. `navigator.onLine` window events — instant but unreliable (stays `true`
 *      on captive-portal Wi-Fi where no request actually completes).
 *   2. A `GET /api/ping` heartbeat while the tab is visible — the ground truth,
 *      used to correct `navigator.onLine`'s false positives. Deliberately the
 *      cheap liveness route, not `/api/health` (whose DB + socket probes would
 *      multiply by open-tab count).
 */

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
