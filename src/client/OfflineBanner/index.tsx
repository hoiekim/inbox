import { useIsOnline, formatLastSeen } from "client";
import "./index.css";

/**
 * Top banner shown only while the server is unreachable (#458 Phase 2). The app
 * keeps rendering the last-known data from the React Query cache (seeded from
 * IndexedDB in Phase 1); this tells the user the data is frozen and offers an
 * immediate reconnect attempt.
 */
const OfflineBanner = () => {
  const { isOnline, lastSeenOnline, recheck } = useIsOnline();

  if (isOnline) return null;

  return (
    <div className="offline-banner" role="status" aria-live="polite">
      <span className="offline-banner-message">
        Offline — showing data as of {formatLastSeen(lastSeenOnline)}
      </span>
      <button type="button" className="offline-banner-retry" onClick={recheck}>
        Retry
      </button>
    </div>
  );
};

export default OfflineBanner;
