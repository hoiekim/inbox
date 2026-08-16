import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// `useLocalStorage` needs a real React render to exercise its state updater.
// Register happy-dom for this file only (and tear it down after) so the rest of
// the suite keeps running on the bare Bun runtime — same pattern as
// `html.test.ts`.
beforeAll(() => {
  GlobalRegistrator.register();
  // React 18 only lets `act` flush work when this flag is set.
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

/**
 * Shadows `window.localStorage` with a recording stand-in. happy-dom's real
 * `localStorage` is a proxy whose method lookups don't honour a
 * `Storage.prototype` patch, so a spy has to replace the object itself.
 */
const fakeLocalStorage = () => {
  const store = new Map<string, string>();
  const writes: [string, string][] = [];
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        writes.push([key, value]);
        store.set(key, value);
      },
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear()
    }
  });
  return { writes, store };
};

const render = async (Probe: () => null) => {
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Probe));
  });

  return {
    act,
    teardown: async () => {
      await act(async () => root.unmount());
      container.remove();
    }
  };
};

describe("useLocalStorage", () => {
  let storage: ReturnType<typeof fakeLocalStorage>;
  beforeEach(() => {
    storage = fakeLocalStorage();
  });

  it("writes a changed value through to localStorage", async () => {
    const { useLocalStorage } = await import("./hooks");

    let setValue!: (value: string) => void;
    let seen!: string;
    const { act, teardown } = await render(() => {
      const [value, setter] = useLocalStorage("draft", "");
      setValue = setter;
      seen = value;
      return null;
    });

    try {
      await act(async () => setValue("a"));
      expect(seen).toBe("a");
      expect(storage.writes).toEqual([["draft", '"a"']]);
      expect(storage.store.get("draft")).toBe('"a"');
    } finally {
      await teardown();
    }
  });

  it("skips the synchronous setItem when the value already stored is set again", async () => {
    const { useLocalStorage } = await import("./hooks");

    let setValue!: (value: string) => void;
    const { act, teardown } = await render(() => {
      const [, setter] = useLocalStorage("draft", "");
      setValue = setter;
      return null;
    });

    try {
      await act(async () => setValue("a"));
      await act(async () => setValue("a"));
      await act(async () => setValue("a"));
      expect(storage.writes).toEqual([["draft", '"a"']]);

      await act(async () => setValue("b"));
      expect(storage.writes).toEqual([
        ["draft", '"a"'],
        ["draft", '"b"']
      ]);
    } finally {
      await teardown();
    }
  });

  it("compares serialized values, so an equal object rebuilt per call writes once", async () => {
    const { useLocalStorage } = await import("./hooks");

    let setValue!: (value: { id: string }) => void;
    const { act, teardown } = await render(() => {
      const [, setter] = useLocalStorage("meta", { id: "" });
      setValue = setter;
      return null;
    });

    try {
      // Reference equality would let the second call through; the guard
      // compares the serialized form, so only the first call writes.
      await act(async () => setValue({ id: "x" }));
      await act(async () => setValue({ id: "x" }));
      expect(storage.writes).toEqual([["meta", '{"id":"x"}']]);
    } finally {
      await teardown();
    }
  });

  it("does not re-write a value the read-time `sanitize` already persisted", async () => {
    // The read persists what `sanitize` returned, so the first set matches
    // storage and must be skipped. Comparing against React state instead
    // would be indistinguishable here and wrong in the cleared-underneath
    // case below.
    storage.store.set("category", '"Search"');
    const { useLocalStorage } = await import("./hooks");

    let setValue!: (value: string) => void;
    let seen!: string;
    const { act, teardown } = await render(() => {
      const [value, setter] = useLocalStorage("category", "AllMails", (v) =>
        v === "Search" ? "AllMails" : v
      );
      setValue = setter;
      seen = value;
      return null;
    });

    try {
      expect(seen).toBe("AllMails");
      await act(async () => setValue("AllMails"));
      expect(storage.writes).toEqual([["category", '"AllMails"']]);
      expect(storage.store.get("category")).toBe('"AllMails"');
    } finally {
      await teardown();
    }
  });

  it("heals storage after it is cleared underneath a mounted component", async () => {
    const { useLocalStorage } = await import("./hooks");

    let setValue!: (value: string) => void;
    const { act, teardown } = await render(() => {
      const [, setter] = useLocalStorage("draft", "");
      setValue = setter;
      return null;
    });

    try {
      await act(async () => setValue("a"));
      expect(storage.store.get("draft")).toBe('"a"');

      // Another tab, or the app-version `localStorage.clear()`, wipes the key
      // while this component stays mounted holding "a" in state.
      storage.store.delete("draft");
      await act(async () => setValue("a"));
      expect(storage.store.get("draft")).toBe('"a"');
    } finally {
      await teardown();
    }
  });

  it("heals storage holding unparseable JSON that fell back to the initial value", async () => {
    storage.store.set("draft", "{not json");
    const { useLocalStorage } = await import("./hooks");

    let setValue!: (value: string) => void;
    let seen!: string;
    const { act, teardown } = await render(() => {
      const [value, setter] = useLocalStorage("draft", "fallback");
      setValue = setter;
      seen = value;
      return null;
    });

    try {
      expect(seen).toBe("fallback");
      await act(async () => setValue("fallback"));
      expect(storage.store.get("draft")).toBe('"fallback"');
    } finally {
      await teardown();
    }
  });

  it("contains a failing setItem — state still advances and nothing escapes to React", async () => {
    // React re-throws an updater's error during the render phase, past the
    // hook's outer try/catch, where the app-level ErrorBoundary would swap out
    // the whole mail UI. A full-quota write must not cost the user their
    // session, so the throw has to be caught inside the updater.
    (window.localStorage as { setItem: (k: string, v: string) => void }).setItem =
      () => {
        throw new DOMException("quota", "QuotaExceededError");
      };
    const { useLocalStorage } = await import("./hooks");

    let setValue!: (value: string) => void;
    let seen!: string;
    const { act, teardown } = await render(() => {
      const [value, setter] = useLocalStorage("draft", "");
      setValue = setter;
      seen = value;
      return null;
    });

    try {
      await act(async () => setValue("too big"));
      expect(seen).toBe("too big");
    } finally {
      await teardown();
    }
  });

  it("supports the updater form and seeds state from an existing stored value", async () => {
    storage.store.set("count", "7");
    const { useLocalStorage } = await import("./hooks");

    let setValue!: (value: (previous: number) => number) => void;
    let seen!: number;
    const { act, teardown } = await render(() => {
      const [value, setter] = useLocalStorage("count", 0);
      setValue = setter;
      seen = value;
      return null;
    });

    try {
      expect(seen).toBe(7);
      await act(async () => setValue((previous) => previous + 1));
      expect(seen).toBe(8);
      expect(storage.writes).toEqual([["count", "8"]]);
    } finally {
      await teardown();
    }
  });

  describe("sanitize", () => {
    const rejectSearch = (value: string) =>
      value === "Search" ? "All Mails" : value;

    const mount = async <T>(
      key: string,
      initialValue: T,
      sanitize?: (value: T) => T
    ) => {
      const { useLocalStorage } = await import("./hooks");

      let seen!: T;
      const { teardown } = await render(() => {
        const [value] = useLocalStorage(key, initialValue, sanitize);
        seen = value;
        return null;
      });
      await teardown();
      return seen;
    };

    it("writes the sanitized value back to storage on read, not just to state", async () => {
      storage.store.set("selectedCategory", JSON.stringify("Search"));

      const seen = await mount("selectedCategory", "All Mails", rejectSearch);

      expect(seen).toBe("All Mails");
      // Asserting state alone is what let a reset effect ship unreachable: the
      // state read "All Mails" while storage still read "Search", so any effect
      // testing for Search never fired, and the next reload resurrected it.
      expect(storage.store.get("selectedCategory")).toBe(
        JSON.stringify("All Mails")
      );
      expect(storage.writes).toEqual([
        ["selectedCategory", JSON.stringify("All Mails")]
      ]);
    });

    it("leaves storage untouched when sanitize accepts the stored value", async () => {
      storage.store.set("selectedCategory", JSON.stringify("Saved"));

      const seen = await mount("selectedCategory", "All Mails", rejectSearch);

      expect(seen).toBe("Saved");
      // The absence of the write is the assertion: rewriting the same string
      // is invisible to a value check but is a real write on every mount.
      expect(storage.writes).toEqual([]);
    });

    it("does not create a key that was never stored, even when sanitize rewrites the initial value", async () => {
      // The initial value is itself something sanitize rejects, so the
      // rewrite test is true on the absent-key path. Without the guard this
      // writes a key the user never set, making "never visited"
      // indistinguishable from "explicitly chose the default".
      const seen = await mount("selectedCategory", "Search", rejectSearch);

      expect(seen).toBe("All Mails");
      expect(storage.store.has("selectedCategory")).toBe(false);
    });

    it("is a no-op without a sanitize callback", async () => {
      storage.store.set("isWriterOpen", JSON.stringify(true));

      const seen = await mount("isWriterOpen", false);

      expect(seen).toBe(true);
      expect(storage.writes).toEqual([]);
    });

    it("falls back to the initial value when the stored JSON is corrupt", async () => {
      storage.store.set("selectedCategory", "{not json");

      const seen = await mount("selectedCategory", "All Mails", rejectSearch);

      expect(seen).toBe("All Mails");
    });
  });
});
