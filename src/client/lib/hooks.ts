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
          const serialized = JSON.stringify(valueToStore);
          // `setItem` is synchronous and blocks the main thread, so writing a
          // value the key already holds is pure cost. Compare against storage
          // rather than against `oldValue` — React state and storage do drift
          // (another tab, a `clear()`, the `sanitize` above rewriting the value
          // on read), and skipping on state equality would strand the stale
          // stored value permanently. This still guarantees storage holds
          // `valueToStore` once the setter returns.
          if (serialized !== window.localStorage.getItem(key)) {
            window.localStorage.setItem(key, serialized);
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


