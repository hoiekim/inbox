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

  // Issue 786's shape: a search term left in `selectedAccount` by a reload out
  // of Search mode. No row highlights it and no affordance recovers it.
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

  // A pending accounts fetch has no lists yet. Doubly covered — the resolver
  // also declines an empty payload — so this asserts the property, not the
  // `!lists` guard, which is type narrowing.
  it("writes nothing before the payload has loaded", async () => {
    const { writes, settled } = await drive(
      "second@x.com",
      Category.AllMails,
      undefined
    );
    expect(writes).toEqual([]);
    expect(settled).toBe("second@x.com");
  });

  // The convergence claim, driven rather than argued: every category over a
  // payload whose New/Saved/Sent views are empty, from a selection none of
  // them list.
  it("settles in at most one write from any category", async () => {
    const lists = { received: [makeAccount("only@x.com")], sent: [], spam: [] };
    for (const category of Object.values(Category)) {
      const { writes } = await drive("phantom@x.com", category, lists);
      expect(writes.length).toBeLessThanOrEqual(1);
    }
  });
});
