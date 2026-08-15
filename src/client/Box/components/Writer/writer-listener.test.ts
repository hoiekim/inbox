/**
 * The compose editor must bind its tiptap `update` handler once per editor
 * instance, not once per render (#768).
 *
 * `@tiptap/core`'s `EventEmitter.on` appends without deduping and `emit` walks
 * the whole array, so a registration in the render body grows the callback list
 * by one per render and never prunes it. Every accumulated handler re-serializes
 * the document and issues a synchronous `localStorage.setItem`, which made an
 * n-character mail cost O(n^2).
 *
 * These tests render the real `Writer` and read the live `Editor`'s callback
 * list, so a regression is caught here rather than only by a manual E2E.
 */

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

type TiptapEditor = {
  callbacks: Record<string, unknown[]>;
  getHTML: () => string;
  commands: { insertContent: (content: string) => boolean; focus: () => boolean };
};

/**
 * Reaches the live tiptap `Editor` from the rendered DOM. tiptap appends
 * `view.dom` (`.ProseMirror`) imperatively, so that node carries no fiber —
 * walk up to the nearest React-owned ancestor, then up the fiber chain to
 * `EditorContent`, which holds `editor` in its props.
 */
const findEditor = (): TiptapEditor | null => {
  let element: Element | null = document.querySelector(".ProseMirror");
  while (element) {
    const fiberKey = Object.keys(element).find((k) =>
      k.startsWith("__reactFiber$")
    );
    if (fiberKey) {
      let fiber = (element as unknown as Record<string, FiberLike>)[fiberKey];
      for (let depth = 0; fiber && depth < 60; depth++) {
        const editor = fiber.memoizedProps?.editor;
        if (editor?.callbacks) return editor;
        fiber = fiber.return as FiberLike;
      }
    }
    element = element.parentElement;
  }
  return null;
};

interface FiberLike {
  memoizedProps?: { editor?: TiptapEditor };
  return?: unknown;
}

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
    // Re-rendering the same element tree from the root is exactly what the old
    // bare-statement registration reacted to.
    rerender: render,
    // `probe` runs in the same synchronous turn as `root.unmount()`, before
    // tiptap's `scheduleDestroy` (a `setTimeout(..., 1)`) can interleave and
    // replace `callbacks` wholesale. Reading the callback list after `teardown`
    // resolves would race that timer.
    teardown: async (probe?: () => void) => {
      await act(async () => {
        root.unmount();
        probe?.();
      });
      container.remove();
    },
  };
};

describe("Writer tiptap update listener", () => {
  beforeEach(() => window.localStorage.clear());

  it("binds exactly one `update` handler and does not add one per render", async () => {
    const { rerender, teardown } = await mountWriter();

    try {
      const editor = findEditor();
      expect(editor).not.toBeNull();

      const initial = editor!.callbacks.update.length;
      for (let i = 0; i < 20; i++) await rerender();

      // Before the fix this grew by one per render (20 renders -> +20).
      expect(editor!.callbacks.update.length).toBe(initial);
    } finally {
      await teardown();
    }
  });

  it("keeps the handler count flat across document edits", async () => {
    const { act, teardown } = await mountWriter();

    try {
      const editor = findEditor();
      expect(editor).not.toBeNull();
      const initial = editor!.callbacks.update.length;

      for (let i = 0; i < 20; i++) {
        await act(async () => {
          editor!.commands.insertContent("a");
        });
      }

      expect(editor!.callbacks.update.length).toBe(initial);
    } finally {
      await teardown();
    }
  });

  it("persists the document to localStorage on edit and unbinds on unmount", async () => {
    const { act, teardown } = await mountWriter();

    let editor!: TiptapEditor;
    let whileMounted!: number;
    let afterUnmount: number | undefined;

    try {
      editor = findEditor()!;
      expect(editor).not.toBeNull();
      whileMounted = editor.callbacks.update.length;

      await act(async () => {
        editor.commands.insertContent("hello");
      });
      expect(window.localStorage.getItem("initialContent")).toContain("hello");
    } finally {
      // Read the count inside the unmount turn — see `teardown`. Capturing the
      // array reference beforehand would not work either: `EventEmitter.off`
      // filters into a new array rather than splicing in place.
      await teardown(() => {
        afterUnmount = editor.callbacks.update.length;
      });
    }

    // tiptap registers its own internal `update` callbacks, so the absolute
    // count is not zero after teardown — what matters is that the component's
    // handler is gone.
    expect(afterUnmount).toBe(whileMounted - 1);
  });
});
