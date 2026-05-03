import { KeyboardEvent } from "react";

/**
 * Wrap a click-style handler so it also fires on Enter/Space when focused.
 * Use with `role="button"` and `tabIndex={0}` on non-button elements that
 * have `onClick`.
 */
export const onKeyboardActivate =
  (handler: () => void) => (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handler();
    }
  };
