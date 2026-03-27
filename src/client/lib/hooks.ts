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
          window.localStorage.setItem(key, JSON.stringify(valueToStore));
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


