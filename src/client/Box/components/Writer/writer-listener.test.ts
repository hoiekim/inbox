import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => {
  GlobalRegistrator.register();
  // React 18 only lets `act` flush work when this flag is set.
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

const { Editor } = await import("client/lib/editor");

type EditorInstance = InstanceType<typeof Editor>;

/**
 * Counts the editor's live update subscriptions by wrapping `onUpdate` and
 * the unsubscribe function it returns.
 */
const trackSubscriptions = () => {
  const original = Editor.prototype.onUpdate;
  const tracker = { active: 0, editor: null as EditorInstance | null };
  Editor.prototype.onUpdate = function (this: EditorInstance, fn: () => void) {
    tracker.active++;
    tracker.editor = this;
    const off = original.call(this, fn);
    return () => {
      tracker.active--;
      off();
    };
  };
  return { tracker, restore: () => (Editor.prototype.onUpdate = original) };
};

const mountWriter = async () => {
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("react-query");
  const { Context } = await import("client");
  const Writer = (await import("./index")).default;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  // Minimum context `Writer` reads. `replyData` must be an object — the reply
  // effect dereferences `replyData.id` on mount.
  const contextValue = {
    domainName: "example.com",
    isWriterOpen: true,
    setIsWriterOpen: () => {},
    replyData: {},
    setReplyData: () => {},
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const render = async () =>
    act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            Context.Provider,
            { value: contextValue as never },
            createElement(Writer)
          )
        )
      );
    });

  await render();

  return {
    act,
    rerender: render,
    teardown: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
};

describe("Writer editor update listener", () => {
  beforeEach(() => window.localStorage.clear());

  it("subscribes once and does not add a subscription per render", async () => {
    const { tracker, restore } = trackSubscriptions();
    const { rerender, teardown } = await mountWriter();
    try {
      expect(tracker.active).toBe(1);
      for (let i = 0; i < 20; i++) await rerender();
      expect(tracker.active).toBe(1);
    } finally {
      await teardown();
      restore();
    }
  });

  it("keeps one subscription across document edits", async () => {
    const { tracker, restore } = trackSubscriptions();
    const { act, teardown } = await mountWriter();
    try {
      for (let i = 0; i < 20; i++) {
        await act(async () => {
          tracker.editor!.insertText("a");
        });
      }
      expect(tracker.active).toBe(1);
    } finally {
      await teardown();
      restore();
    }
  });

  it("persists the document to localStorage on edit and unsubscribes on unmount", async () => {
    const { tracker, restore } = trackSubscriptions();
    const { act, teardown } = await mountWriter();
    try {
      await act(async () => {
        tracker.editor!.insertText("hello");
      });
      expect(window.localStorage.getItem("initialContent")).toContain("hello");
    } finally {
      await teardown();
      restore();
    }
    expect(tracker.active).toBe(0);
  });
});
