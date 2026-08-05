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
      try {
        setStoredValue((oldValue) => {
          const valueToStore =
            value instanceof Function ? value(oldValue) : value;
          // React re-throws an updater's error during the render phase, past
          // the outer catch, where the ErrorBoundary would swap out the whole
          // app. A full-quota `setItem` must not cost the user their session,
          // so persistence failures are contained here and state still moves.
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
      } catch (error) {
        console.error(error);
      }
    },
    [key, setStoredValue]
  );

  return [
    storedValue as T,
    setValue as React.Dispatch<React.SetStateAction<T>>
  ] as const;
};


