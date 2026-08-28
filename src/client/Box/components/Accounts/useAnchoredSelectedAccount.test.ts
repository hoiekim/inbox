import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Account } from "common";
import { Category } from "client";
import { AccountLists } from "./selectableAccounts";

// The hook is the wiring the sidebar depends on: it has to converge inside a
// real render loop, not just return the right value. Register happy-dom for
// this file only — same pattern as `lib/hooks.test.ts`.
beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

const makeAccount = (key: string, unread = 0, saved = 0) =>
  new Account({
    key,
    updated: new Date("2026-01-01"),
    doc_count: 1,
    unread_doc_count: unread,
    saved_doc_count: saved
  });

const received = [makeAccount("first@x.com"), makeAccount("second@x.com")];
const sent = [makeAccount("sender@x.com")];
const spam = [makeAccount("spammy@x.com")];

/**
 * Mounts the real hook over a `selectedAccount` state cell and lets React
 * settle. A hook that never converged would blow the update depth here rather
 * than return a wrong value, so the write log is what the assertions read.
 */
const drive = async (
  selection: string,
  category: Category,
  lists: AccountLists | undefined
) => {
  const { createElement, useState, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useAnchoredSelectedAccount } = await import(
    "./useAnchoredSelectedAccount"
  );

  const writes: string[] = [];
  let settled = selection;

  const Probe = () => {
    const [selected, setSelected] = useState(selection);
    settled = selected;
    useAnchoredSelectedAccount(selected, category, lists, (next) => {
      writes.push(next);
      setSelected(next);
    });
    return null;
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Probe));
  });
  await act(async () => root.unmount());
  container.remove();

  return { writes, settled };
};

/**
 * Mounts with no payload, then supplies one — the transition a real session
 * makes when the accounts fetch resolves. Neither `selectedAccount` nor
 * `selectedCategory` moves across it, so only an effect that lists `lists`
 * among its dependencies runs a second time and sees the payload at all.
 */
const driveLoad = async (
  selection: string,
  category: Category,
  lists: AccountLists
) => {
  const { createElement, useState, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useAnchoredSelectedAccount } = await import(
    "./useAnchoredSelectedAccount"
  );

  const writes: string[] = [];

  const Probe = ({ loaded }: { loaded: boolean }) => {
    const [selected, setSelected] = useState(selection);
    useAnchoredSelectedAccount(
      selected,
      category,
      loaded ? lists : undefined,
      (next) => {
        writes.push(next);
        setSelected(next);
      }
    );
    return null;
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Probe, { loaded: false }));
  });
  await act(async () => {
    root.render(createElement(Probe, { loaded: true }));
  });
  await act(async () => root.unmount());
  container.remove();

  return writes;
};

describe("useAnchoredSelectedAccount", () => {
  it("picks the category's first account on a fresh login", async () => {
    const { writes, settled } = await drive("", Category.AllMails, {
      received,
      sent,
      spam
    });
    expect(writes).toEqual(["first@x.com"]);
    expect(settled).toBe("first@x.com");
  });

  // A search term left in `selectedAccount` by a reload out of Search mode.
  // No row highlights it and no affordance recovers it.
  it("re-anchors a name no list contains, in one write", async () => {
    const { writes, settled } = await drive("keyword", Category.AllMails, {
      received,
      sent,
      spam
    });
    expect(writes).toEqual(["first@x.com"]);
    expect(settled).toBe("first@x.com");
  });

  it("leaves a selection the category lists alone", async () => {
    const { writes, settled } = await drive("second@x.com", Category.AllMails, {
      received,
      sent,
      spam
    });
    expect(writes).toEqual([]);
    expect(settled).toBe("second@x.com");
  });

  // Clicking an empty category tab and clicking back must not cost the
  // selection: `onClickCategory` deliberately leaves it alone when the
  // destination lists nothing, and clearing it here would send the return trip
  // to `received[0]` instead.
  it("keeps the selection while the category lists nothing", async () => {
    const { writes, settled } = await drive("second@x.com", Category.SentMails, {
      received,
      sent: [],
      spam
    });
    expect(writes).toEqual([]);
    expect(settled).toBe("second@x.com");
  });

  it("keeps the live search term in Search", async () => {
    const { writes, settled } = await drive("keyword", Category.Search, {
      received,
      sent,
      spam
    });
    expect(writes).toEqual([]);
    expect(settled).toBe("keyword");
  });

  // A pending accounts fetch has no lists at all, which is not the same as
  // three empty ones: accountsForCategory destructures its payload, so
  // reaching the resolver with nothing loaded throws rather than declining.
  it("writes nothing before the payload has loaded", async () => {
    const { writes, settled } = await drive(
      "second@x.com",
      Category.AllMails,
      undefined
    );
    expect(writes).toEqual([]);
    expect(settled).toBe("second@x.com");
  });

  // The clear is a write of `""`, not the absence of one: the consumer keeps it
  // by testing `resolved !== null`, and the obvious `if (resolved)` reads as an
  // equivalent simplification while dropping every clear. Assert the raw value
  // — filtering the log for truthiness would erase the artifact under test.
  it("clears a phantom to the empty string when no list holds it", async () => {
    const { writes, settled } = await drive(
      "phantom@x.com",
      Category.SentMails,
      { received, sent: [], spam }
    );
    expect(writes).toEqual([""]);
    expect(settled).toBe("");
  });

  // The convergence claim, driven rather than argued: every category over a
  // payload whose New/Saved/Sent views are empty, from a selection none of
  // them list. Asserted as one map so a divergence names its category.
  it("settles in one write of the right value from any category", async () => {
    const lists = { received: [makeAccount("only@x.com")], sent: [], spam: [] };
    const writesByCategory: Partial<Record<Category, string[]>> = {};
    for (const category of Object.values(Category)) {
      writesByCategory[category] = (
        await drive("phantom@x.com", category, lists)
      ).writes;
    }
    expect(writesByCategory).toEqual({
      [Category.NewMails]: [""],
      [Category.AllMails]: ["only@x.com"],
      [Category.SavedMails]: [""],
      [Category.SentMails]: [""],
      [Category.SpamMails]: [""],
      [Category.Search]: []
    });
  });

  it("re-anchors when the payload arrives, not only when the selection moves", async () => {
    const writes = await driveLoad("phantom@x.com", Category.AllMails, {
      received,
      sent,
      spam
    });
    expect(writes).toEqual(["first@x.com"]);
  });

  // The one line no render reaches: the call site decides when a payload counts
  // as loaded, and the hook's own `if (!lists) return` sits downstream of that
  // choice and cannot audit it. Dropping to `query.data` is not caught by the
  // undefined guard — react-query v3's error action spreads the previous state
  // without clearing `data` (`core/query.js`), so a failed refetch leaves the
  // last payload in place while `isSuccess` goes false, and the resolver would
  // re-anchor against membership the server has since contradicted. Read via
  // `Bun.file` rather than `fs`: sibling suites `mock.module("fs", ...)`, which
  // is process-global in Bun. Whitespace is stripped, not collapsed, so a
  // rewrap is not a failure.
  it("withholds the payload from the hook until the accounts query succeeds", async () => {
    const source = await Bun.file(
      new URL("./index.tsx", import.meta.url)
    ).text();
    const start = source.indexOf("useAnchoredSelectedAccount(");
    if (start === -1) throw new Error("hook call site missing from Accounts");
    const end = source.indexOf(");", start);
    if (end === -1) throw new Error("hook call site never closes in Accounts");
    expect(source.slice(start, end + 2).replace(/\s+/g, "")).toBe(
      "useAnchoredSelectedAccount(selectedAccount,selectedCategory," +
        "query.isSuccess?query.data:undefined,setSelectedAccount);"
    );
  });
});
