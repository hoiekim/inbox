import { useState, useEffect, useCallback } from "react";

export const useLocalStorage = <T>(
  key: string,
  initialValue: T,
  sanitize?: (value: T) => T
) => {
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      const parsed: T = item ? JSON.parse(item) : initialValue;
      return sanitize ? sanitize(parsed) : parsed;
    } catch (error) {
      console.error(error);
      return initialValue;
    }
  });

  const setValue = useCallback(
    (value: T | ((val: T) => T)) => {
      setStoredValue((oldValue) => {
        const valueToStore =
          value instanceof Function ? value(oldValue) : value;
        // Contain persistence failures here, not around `setStoredValue`:
        // React re-throws an updater's error during the render phase, so a
        // catch out there never sees a full-quota `setItem` — it only sees
        // React's own "Maximum update depth exceeded", which should crash
        // loudly rather than wedge the app silently.
        try {
          const serialized = JSON.stringify(valueToStore);
          // Compare against storage rather than against `oldValue`: the two
          // drift (another tab, a `clear()`, the `sanitize` above rewriting
          // the value on read), and skipping on state equality would strand
          // the stale stored value permanently.
          if (serialized !== window.localStorage.getItem(key)) {
            window.localStorage.setItem(key, serialized);
          }
        } catch (error) {
          console.error(error);
        }
        return valueToStore;
      });
    },
    [key, setStoredValue]
  );

  return [
    storedValue as T,
    setValue as React.Dispatch<React.SetStateAction<T>>
  ] as const;
};


