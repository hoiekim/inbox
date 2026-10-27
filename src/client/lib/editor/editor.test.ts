import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const { Editor } = await import("./editor");
const { handleCopy, handleDragStart, handleDrop, handlePaste } = await import("./clipboard");
const { Transaction } = await import("./state");
const { deleteSelection, selectAll } = await import("./commands");

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

  test("an input the browser applies anyway is not also applied to the model", async () => {
    for (const cancelable of [true, false]) {
      const editor = new Editor({ content: "<p>abcd</p>" });
      document.body.appendChild(editor.dom);
      const text = editor.dom.querySelector("p")!.firstChild as Text;
      editor.focus();
      document.getSelection()!.setBaseAndExtent(text, 4, text, 4);
      const input = new InputEvent("beforeinput", {
        inputType: "deleteContentBackward",
        cancelable,
        bubbles: true
      });
      editor.dom.dispatchEvent(input);
      expect(input.defaultPrevented).toBe(cancelable);
      if (!input.defaultPrevented) {
        // The browser's own edit: one character off whatever the DOM holds now.
        expect(editor.getHTML()).toBe("<p>abcd</p>");
        const node = editor.dom.querySelector("p")!.firstChild as Text;
        node.data = node.data.slice(0, -1);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(editor.getHTML()).toBe("<p>abc</p>");
      editor.destroy();
      editor.dom.remove();
    }
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
      editor.destroy();
    });
  }
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
