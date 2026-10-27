import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const { Editor } = await import("./editor");
const { handleCopy, handleDragStart, handleDrop, handlePaste } = await import("./clipboard");
const { Transaction } = await import("./state");
const { deleteSelection, selectAll, splitBlock } = await import("./commands");

const at = (editor: InstanceType<typeof Editor>, pos: number) => {
  const tr = new Transaction(editor.state);
  tr.setSelection({ anchor: pos, head: pos });
  editor.dispatch(tr);
};

const pasteInto = (content: string, pos: number, data: { html?: string; text?: string }) => {
  const editor = new Editor({ content });
  at(editor, pos);
  const clipboardData = {
    getData: (type: string) =>
      type === "text/html" ? data.html ?? "" : type === "text/plain" ? data.text ?? "" : ""
  };
  handlePaste(editor, { clipboardData } as unknown as ClipboardEvent);
  const html = editor.getHTML();
  editor.destroy();
  return html;
};

describe("Editor", () => {
  test("loads and serializes HTML", () => {
    const editor = new Editor({ content: "<p>Hello <strong>world</strong></p>" });
    expect(editor.getHTML()).toBe("<p>Hello <strong>world</strong></p>");
    expect(editor.dom.querySelector("strong")?.textContent).toBe("world");
    editor.destroy();
  });

  test("setContent can be undone and does not notify listeners", () => {
    const editor = new Editor({ content: "<p>before</p>" });
    let updates = 0;
    editor.onUpdate(() => updates++);
    editor.setContent("<p>after</p>");
    expect(editor.getHTML()).toBe("<p>after</p>");
    expect(updates).toBe(0);
    editor.undo();
    expect(editor.getHTML()).toBe("<p>before</p>");
    expect(updates).toBe(1);
    editor.destroy();
  });

  test("edits notify listeners until unsubscribed", () => {
    const editor = new Editor();
    let updates = 0;
    const off = editor.onUpdate(() => updates++);
    editor.insertText("a");
    off();
    editor.insertText("b");
    expect(updates).toBe(1);
    expect(editor.getHTML()).toBe("<p>ab</p>");
    editor.destroy();
  });

  test("shows the placeholder only while the document is empty", () => {
    const editor = new Editor({ placeholder: "Write here" });
    const first = () => editor.dom.querySelector("p")!;
    expect(first().getAttribute("data-placeholder")).toBe("Write here");
    expect(first().classList.contains("is-editor-empty")).toBe(true);
    editor.insertText("x");
    expect(first().hasAttribute("data-placeholder")).toBe(false);
    editor.destroy();
  });

  test("reads text composed by an input method back from the DOM", async () => {
    const editor = new Editor({ content: "<p>a</p>" });
    document.body.appendChild(editor.dom);
    const text = editor.dom.querySelector("p")!.firstChild as Text;
    editor.focus();
    document.getSelection()!.setBaseAndExtent(text, 1, text, 1);
    editor.dom.dispatchEvent(new Event("compositionstart"));
    text.data = "a한";
    text.data = "a한글";
    editor.dom.dispatchEvent(new Event("compositionend"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(editor.getHTML()).toBe("<p>a한글</p>");
    editor.destroy();
    editor.dom.remove();
  });
});

describe("input events", () => {
  test("text typed during a composition is left to the browser and read back once", async () => {
    const editor = new Editor({ content: "<p>a</p>" });
    document.body.appendChild(editor.dom);
    const text = editor.dom.querySelector("p")!.firstChild as Text;
    editor.focus();
    document.getSelection()!.setBaseAndExtent(text, 1, text, 1);
    editor.dom.dispatchEvent(new Event("compositionstart"));
    const input = new InputEvent("beforeinput", {
      inputType: "insertText",
      data: "한",
      isComposing: true,
      cancelable: true,
      bubbles: true
    });
    editor.dom.dispatchEvent(input);
    expect(input.defaultPrevented).toBe(false);
    expect(editor.getHTML()).toBe("<p>a</p>");
    text.data = "a한";
    editor.dom.dispatchEvent(new Event("compositionend"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(editor.getHTML()).toBe("<p>a한</p>");
    editor.destroy();
    editor.dom.remove();
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  const mount = (content: string) => {
    const editor = new Editor({ content });
    document.body.appendChild(editor.dom);
    editor.focus();
    return editor;
  };
  const unmount = (editor: InstanceType<typeof Editor>) => {
    editor.destroy();
    editor.dom.remove();
  };
  const texts = (editor: InstanceType<typeof Editor>) => {
    const walker = document.createTreeWalker(editor.dom, 4);
    const out: Text[] = [];
    while (walker.nextNode()) out.push(walker.currentNode as Text);
    return out;
  };

  interface NativeCase {
    name: string;
    content: string;
    select: (t: Text[]) => [Text, number, Text, number];
    inputType: string;
    data?: string;
    /** What the browser does to the DOM when it applies the input itself. */
    native: (dom: HTMLElement, t: Text[]) => void;
    expected: string;
  }
  const join = (dom: HTMLElement, t: Text[], text: string) => {
    t[0]!.data = text;
    dom.children[1]!.remove();
  };
  const nativeCases: NativeCase[] = [
    {
      name: "insertText",
      content: "<p>ab</p>",
      select: (t) => [t[0]!, 2, t[0]!, 2],
      inputType: "insertText",
      data: "c",
      native: (_, t) => (t[0]!.data = "abc"),
      expected: "<p>abc</p>"
    },
    {
      name: "deleteContentBackward inside a line",
      content: "<p>abcd</p>",
      select: (t) => [t[0]!, 4, t[0]!, 4],
      inputType: "deleteContentBackward",
      native: (_, t) => (t[0]!.data = "abc"),
      expected: "<p>abc</p>"
    },
    {
      name: "insertParagraph",
      content: "<p>abcd</p>",
      select: (t) => [t[0]!, 2, t[0]!, 2],
      inputType: "insertParagraph",
      native: (dom, t) => {
        t[0]!.data = "ab";
        const p = document.createElement("p");
        p.textContent = "cd";
        dom.appendChild(p);
      },
      expected: "<p>ab</p><p>cd</p>"
    },
    {
      name: "insertLineBreak",
      content: "<p>abcd</p>",
      select: (t) => [t[0]!, 2, t[0]!, 2],
      inputType: "insertLineBreak",
      native: (_, t) => {
        t[0]!.data = "ab";
        t[0]!.after(document.createElement("br"), document.createTextNode("cd"));
      },
      expected: "<p>ab<br>cd</p>"
    },
    {
      name: "deleteContentBackward at the start of a paragraph",
      content: "<p>ab</p><p>cd</p>",
      select: (t) => [t[1]!, 0, t[1]!, 0],
      inputType: "deleteContentBackward",
      native: (dom, t) => join(dom, t, "abcd"),
      expected: "<p>abcd</p>"
    },
    {
      name: "deleteContentForward at the end of a paragraph",
      content: "<p>ab</p><p>cd</p>",
      select: (t) => [t[0]!, 2, t[0]!, 2],
      inputType: "deleteContentForward",
      native: (dom, t) => join(dom, t, "abcd"),
      expected: "<p>abcd</p>"
    },
    {
      name: "deleteWordBackward over two paragraphs",
      content: "<p>ab</p><p>cd</p>",
      select: (t) => [t[0]!, 1, t[1]!, 1],
      inputType: "deleteWordBackward",
      native: (dom, t) => join(dom, t, "ad"),
      expected: "<p>ad</p>"
    },
    {
      name: "deleteByCut over two paragraphs",
      content: "<p>ab</p><p>cd</p>",
      select: (t) => [t[0]!, 1, t[1]!, 1],
      inputType: "deleteByCut",
      native: (dom, t) => join(dom, t, "ad"),
      expected: "<p>ad</p>"
    },
    {
      name: "formatUnderline, which the schema has no mark for",
      content: "<p>ab</p>",
      select: (t) => [t[0]!, 0, t[0]!, 2],
      inputType: "formatUnderline",
      native: (dom, t) => {
        const u = document.createElement("u");
        dom.firstElementChild!.replaceChild(u, t[0]!);
        u.appendChild(t[0]!);
      },
      expected: "<p>ab</p>"
    },
    {
      name: "insertOrderedList, which is not handled",
      content: "<blockquote><p>ab</p></blockquote>",
      select: (t) => [t[0]!, 1, t[0]!, 1],
      inputType: "insertOrderedList",
      native: (dom) => {
        const quote = dom.firstElementChild!;
        const list = document.createElement("ol");
        const item = document.createElement("li");
        list.appendChild(item);
        item.appendChild(quote.replaceChild(list, quote.firstElementChild!));
      },
      expected: "<blockquote><p>ab</p></blockquote>"
    },
    {
      name: "deleteContentBackward the browser makes no change for",
      content: "<ul><li><p>a</p></li></ul>",
      select: (t) => [t[0]!, 0, t[0]!, 0],
      inputType: "deleteContentBackward",
      native: () => {},
      expected: "<p>a</p>"
    }
  ];

  for (const c of nativeCases) {
    test(`${c.name} the browser applies itself lands once`, async () => {
      for (const cancelable of [true, false]) {
        const editor = mount(c.content);
        const before = editor.dom.innerHTML;
        const [a, ao, h, ho] = c.select(texts(editor));
        document.getSelection()!.setBaseAndExtent(a, ao, h, ho);
        const input = new InputEvent("beforeinput", {
          inputType: c.inputType,
          data: c.data ?? null,
          cancelable,
          bubbles: true
        });
        editor.dom.dispatchEvent(input);
        expect(input.defaultPrevented).toBe(cancelable);
        expect(editor.getHTML()).toBe(c.expected);
        if (!cancelable) {
          // The browser edits the DOM as it was before the input.
          expect(editor.dom.innerHTML).toBe(before);
          c.native(editor.dom, texts(editor));
        }
        await settle();
        expect(editor.getHTML()).toBe(c.expected);
        const rendered = new Editor({ content: c.expected });
        expect(editor.dom.innerHTML).toBe(rendered.dom.innerHTML);
        rendered.destroy();
        unmount(editor);
      }
    });
  }

  for (const browserDeletes of [true, false]) {
    test(`a composition right after a non-cancelable Backspace keeps both${browserDeletes ? "" : " (no DOM change)"}`, async () => {
      const editor = mount("<p>abc</p>");
      const text = editor.dom.querySelector("p")!.firstChild as Text;
      document.getSelection()!.setBaseAndExtent(text, 3, text, 3);
      editor.dom.dispatchEvent(
        new InputEvent("beforeinput", { inputType: "deleteContentBackward", cancelable: false, bubbles: true })
      );
      if (browserDeletes) {
        text.data = "ab";
        document.getSelection()!.setBaseAndExtent(text, 2, text, 2);
      }
      // The IME reopens a composition in the same task, before any mutation callback.
      editor.dom.dispatchEvent(new Event("compositionstart"));
      const node = editor.dom.querySelector("p")!.firstChild as Text;
      node.data += "한";
      document.getSelection()!.setBaseAndExtent(node, node.data.length, node, node.data.length);
      editor.dom.dispatchEvent(new Event("compositionend"));
      await settle();
      expect(editor.getHTML()).toBe("<p>ab한</p>");
      unmount(editor);
    });
  }

  test("composition text in a non-cancelable beforeinput is read back, not redrawn away", async () => {
    const editor = mount("<p>ab</p>");
    const text = editor.dom.querySelector("p")!.firstChild as Text;
    document.getSelection()!.setBaseAndExtent(text, 2, text, 2);
    editor.dom.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertCompositionText",
        data: "한",
        cancelable: false,
        bubbles: true
      })
    );
    text.data = "ab한";
    await settle();
    expect(editor.getHTML()).toBe("<p>ab한</p>");
    unmount(editor);
  });

  test("a block the browser adds outside any input is taken out again", async () => {
    const editor = mount("<blockquote><p>a</p></blockquote>");
    const stray = document.createElement("p");
    stray.textContent = "x";
    editor.dom.firstElementChild!.appendChild(stray);
    await settle();
    expect(editor.getHTML()).toBe("<blockquote><p>a</p></blockquote>");
    expect(editor.dom.innerHTML).toBe("<blockquote><p>a</p></blockquote>");
    unmount(editor);
  });

  const wholeDocShapes = [
    "<p>abc</p><p>def</p>",
    "<ul><li><p>a</p></li></ul><p>b</p>",
    "<blockquote><p>q</p></blockquote><p>r</p>",
    "<pre><code>c</code></pre><p>d</p>",
    "<hr><p>x</p>",
    "<p>a</p><hr>"
  ];
  for (const content of wholeDocShapes) {
    for (const lift of [false, true]) {
      test(`a composition over all of ${content} keeps the composed text${lift ? " (block moved to the top)" : ""}`, async () => {
        const editor = mount(content);
        editor.run(selectAll);
        editor.dom.dispatchEvent(new Event("compositionstart"));
        // The browser deletes everything but the first block it can type in.
        const text = texts(editor)[0]!;
        let top: Element = text.parentElement!;
        while (top.parentElement !== editor.dom) top = top.parentElement!;
        for (const el of Array.from(editor.dom.children)) if (el !== top) el.remove();
        if (lift && top !== text.parentElement) top.replaceWith(text.parentElement!);
        text.data = "한";
        document.getSelection()!.setBaseAndExtent(text, 1, text, 1);
        editor.dom.dispatchEvent(new Event("compositionend"));
        await settle();
        expect(editor.getHTML()).toBe("<p>한</p>");
        expect(editor.dom.innerHTML).toBe("<p>한</p>");
        unmount(editor);
      });
    }
  }

  const chromeLeftovers: [string, (dom: HTMLElement) => Text][] = [
    [
      "<pre><code>c</code></pre><p>d</p>",
      (dom) => {
        const pre = dom.querySelector("pre")!;
        const font = document.createElement("font");
        font.textContent = "한";
        pre.replaceChildren(font);
        dom.replaceChildren(pre);
        return font.firstChild as Text;
      }
    ],
    [
      "<hr><p>x</p>",
      (dom) => {
        const text = document.createTextNode("한");
        dom.replaceChildren(text);
        return text;
      }
    ]
  ];
  for (const [content, leave] of chromeLeftovers) {
    test(`a composition over all of ${content} reads back text the browser left outside any block`, async () => {
      const editor = mount(content);
      editor.run(selectAll);
      editor.dom.dispatchEvent(new Event("compositionstart"));
      const text = leave(editor.dom);
      document.getSelection()!.setBaseAndExtent(text, 1, text, 1);
      editor.dom.dispatchEvent(new Event("compositionend"));
      await settle();
      expect(editor.getHTML()).toBe("<p>한</p>");
      expect(editor.dom.innerHTML).toBe("<p>한</p>");
      unmount(editor);
    });
  }

  test("a composition over all of the document reads back the block the caret ends in", async () => {
    const editor = mount("<p>abc</p><blockquote><p>def</p></blockquote>");
    editor.run(selectAll);
    editor.dom.dispatchEvent(new Event("compositionstart"));
    const last = editor.dom.lastElementChild!;
    editor.dom.firstElementChild!.remove();
    const text = last.querySelector("p")!.firstChild as Text;
    text.data = "한";
    document.getSelection()!.setBaseAndExtent(text, 1, text, 1);
    editor.dom.dispatchEvent(new Event("compositionend"));
    await settle();
    expect(editor.getHTML()).toBe("<p>한</p>");
    unmount(editor);
  });

  test("a composition over all of the document is read back when the caret is not in a block", async () => {
    const editor = mount("<blockquote><p>abc</p></blockquote><p>def</p>");
    editor.run(selectAll);
    editor.dom.dispatchEvent(new Event("compositionstart"));
    editor.dom.lastElementChild!.remove();
    const text = editor.dom.querySelector("p")!.firstChild as Text;
    text.data = "한";
    document.getSelection()!.setBaseAndExtent(editor.dom, 1, editor.dom, 1);
    editor.dom.dispatchEvent(new Event("compositionend"));
    await settle();
    expect(editor.getHTML()).toBe("<p>한</p>");
    unmount(editor);
  });

  test("a composition over a selection spanning blocks merges them", async () => {
    const editor = new Editor({ content: "<p>abc</p><p>def</p>" });
    document.body.appendChild(editor.dom);
    const [first, second] = Array.from(editor.dom.querySelectorAll("p"));
    const t1 = first!.firstChild as Text;
    const t2 = second!.firstChild as Text;
    editor.focus();
    document.getSelection()!.setBaseAndExtent(t1, 2, t2, 2);
    editor.dom.dispatchEvent(new Event("compositionstart"));
    second!.remove();
    t1.data = "ab한f";
    document.getSelection()!.setBaseAndExtent(t1, 3, t1, 3);
    editor.dom.dispatchEvent(new Event("compositionend"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(editor.getHTML()).toBe("<p>ab한f</p>");
    expect(editor.dom.querySelectorAll("p").length).toBe(1);
    editor.destroy();
    editor.dom.remove();
  });
});

describe("select all", () => {
  const shapes = [
    "<hr><p>x</p>",
    "<ul><li><p>a</p></li></ul><p>b</p>",
    "<blockquote><p>q</p></blockquote>",
    "<p>a</p><hr>",
    "<pre><code>c</code></pre><p>d</p>"
  ];
  for (const content of shapes) {
    test(`replaces all of ${content} with what is typed`, () => {
      const editor = new Editor({ content });
      editor.run(selectAll);
      editor.insertText("Z");
      expect(editor.getHTML()).toBe("<p>Z</p>");
      editor.run(selectAll);
      editor.run(deleteSelection);
      expect(editor.getHTML()).toBe("<p></p>");
      editor.setContent(content);
      editor.run(selectAll);
      editor.run(splitBlock);
      editor.insertText("Y");
      expect(editor.getHTML()).toBe("<p>Y</p>");
      editor.destroy();
    });
  }

  test("keeps the whole document selected when the browser reports it as text positions", async () => {
    const editor = new Editor({ content: "<blockquote><p>q</p></blockquote><p>r</p>" });
    document.body.appendChild(editor.dom);
    editor.focus();
    editor.run(selectAll);
    const [first, last] = Array.from(editor.dom.querySelectorAll("p")).map((p) => p.firstChild as Text);
    document.getSelection()!.setBaseAndExtent(first!, 0, last!, 1);
    document.dispatchEvent(new Event("selectionchange"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    editor.dom.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "insertText", data: "Z", cancelable: true, bubbles: true })
    );
    expect(editor.getHTML()).toBe("<p>Z</p>");
    editor.destroy();
    editor.dom.remove();
  });
});

describe("paste", () => {
  const cases: [string, number, { html?: string; text?: string }, string][] = [
    ["<p></p>", 1, { html: "<h1>H</h1><p>p</p>" }, "<h1>H</h1><p>p</p>"],
    ["<p>ab</p>", 2, { html: "<h1>H</h1>" }, "<p>aHb</p>"],
    ["<p>ab</p>", 2, { html: "<p>x</p><p>y</p>" }, "<p>ax</p><p>yb</p>"],
    [
      "<p>ab</p>",
      2,
      { html: "<ul><li>x</li><li>y</li></ul>" },
      "<p>ax</p><ul><li><p>yb</p></li></ul>"
    ],
    [
      "<p>ab</p>",
      1,
      { html: "<blockquote><p>q</p></blockquote>" },
      "<blockquote><p>qab</p></blockquote>"
    ],
    ["<p>ab</p>", 2, { html: "<hr>" }, "<p>a</p><hr><p>b</p>"],
    [
      "<ul><li><p>ab</p></li></ul>",
      3,
      { html: "<ul><li>x</li><li>y</li></ul>" },
      "<ul><li><p>x</p></li><li><p>yab</p></li></ul>"
    ],
    ["<p>ab</p>", 2, { text: "line1\nline2\n\nline3" }, "<p>aline1</p><p>line2</p><p>line3b</p>"],
    ["<p><strong>ab</strong></p>", 2, { text: "plain" }, "<p><strong>aplainb</strong></p>"],
    [
      "<p>ab</p>",
      2,
      { text: "**bold** and *it* and `code` x" },
      "<p>a<strong>bold</strong> and <em>it</em> and <code>code</code> xb</p>"
    ],
    [
      "<pre><code>ab</code></pre>",
      2,
      { html: "<p>x</p>", text: "x\n\ny" },
      "<pre><code>ax\n\nyb</code></pre>"
    ]
  ];

  for (const [content, pos, data, expected] of cases) {
    test(`${JSON.stringify(data)} into ${content} at ${pos}`, () => {
      expect(pasteInto(content, pos, data)).toBe(expected);
    });
  }

  test("copies the selection as HTML and text that paste back the same", () => {
    const content = "<p>one <strong>two</strong></p><ul><li><p>three</p></li></ul>";
    const editor = new Editor({ content });
    const tr = new Transaction(editor.state);
    tr.setSelection({ anchor: 5, head: 15 });
    editor.dispatch(tr);
    const data: Record<string, string> = {};
    const event = {
      clipboardData: { setData: (type: string, value: string) => (data[type] = value) },
      preventDefault: () => {}
    };
    handleCopy(editor, event as unknown as ClipboardEvent, false);
    editor.destroy();
    expect(data["text/html"]).toBe("<p><strong>two</strong></p><ul><li><p>thr</p></li></ul>");
    expect(data["text/plain"]).toBe("two\n\nthr");
    expect(pasteInto("<p></p>", 1, { html: data["text/html"] })).toBe(data["text/html"]);
  });

  test("dropping text dragged from the editor moves it, or copies it with the modifier", () => {
    const drag = (copy: boolean) => {
      const editor = new Editor({ content: "<p>alpha beta</p>" });
      const tr = new Transaction(editor.state);
      tr.setSelection({ anchor: 7, head: 11 });
      editor.dispatch(tr);
      const store: Record<string, string> = {};
      const dataTransfer = {
        setData: (type: string, value: string) => (store[type] = value),
        getData: (type: string) => store[type] ?? ""
      };
      handleDragStart(editor, { dataTransfer } as unknown as DragEvent);
      editor.view.posAtCoords = () => 1;
      handleDrop(editor, { dataTransfer, altKey: copy, ctrlKey: copy } as unknown as DragEvent);
      const html = editor.getHTML();
      editor.destroy();
      return html;
    };
    expect(drag(false)).toBe("<p>betaalpha </p>");
    expect(drag(true)).toBe("<p>betaalpha beta</p>");
  });

  test("pasted markup cannot smuggle in scripts or handlers", () => {
    const html = '<img src=x onerror="alert(1)"><script>x()</script><p onclick="y()">ok</p>';
    expect(pasteInto("<p></p>", 1, { html })).toBe("<p>ok</p>");
  });
});
