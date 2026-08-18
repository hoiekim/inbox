import { useIsOnline, formatLastSeen } from "client";
import "./index.scss";

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
