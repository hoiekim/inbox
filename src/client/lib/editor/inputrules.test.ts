import { describe, expect, test } from "bun:test";
import type { Node } from "./model";
import { schema } from "./schema";
import { applyTransaction, createState, type EditorState } from "./state";
import { insertText } from "./commands";
import { runInputRules } from "./inputrules";
import { docToHtml } from "./html";

const p = (text = ""): Node => ({
  type: "paragraph",
  content: text ? [{ type: "text", text }] : []
});
const doc = (...content: Node[]): Node => ({ type: "doc", content });

/** Types `text` one character at a time, running input rules like the editor does. */
const type = (state: EditorState, text: string) => {
  for (const ch of text) {
    insertText(ch)(state, (tr) => {
      state = applyTransaction(state, tr);
    });
    const rule = runInputRules(state, state.selection.head);
    if (rule) state = applyTransaction(state, rule);
  }
  return state;
};

const typed = (text: string, start: Node = doc(p())) =>
  docToHtml(type(createState(schema, start, { anchor: 1, head: 1 }), text).doc);

describe("input rules", () => {
  test("headings", () => {
    expect(typed("# Title")).toBe("<h1>Title</h1>");
    expect(typed("### Small")).toBe("<h3>Small</h3>");
  });

  test("lists", () => {
    expect(typed("- item")).toBe("<ul><li><p>item</p></li></ul>");
    expect(typed("* item")).toBe("<ul><li><p>item</p></li></ul>");
    expect(typed("3. third")).toBe('<ol start="3"><li><p>third</p></li></ol>');
  });

  test("an ordered list continues the list right before it", () => {
    const start = doc({ type: "orderedList", attrs: { start: 1, type: null }, content: [
      { type: "listItem", content: [p("one")] }
    ] }, p());
    const state = type(createState(schema, start, { anchor: 10, head: 10 }), "2. two");
    expect(docToHtml(state.doc)).toBe("<ol><li><p>one</p></li><li><p>two</p></li></ol>");
  });

  test("quotes, code blocks and rules", () => {
    expect(typed("> quoted")).toBe("<blockquote><p>quoted</p></blockquote>");
    expect(typed("```js code")).toBe('<pre><code class="language-js">code</code></pre>');
    expect(typed("---")).toBe("<hr><p></p>");
  });

  test("inline marks", () => {
    expect(typed("a **bold** b")).toBe("<p>a <strong>bold</strong> b</p>");
    expect(typed("a *it* b")).toBe("<p>a <em>it</em> b</p>");
    expect(typed("a ~~gone~~ b")).toBe("<p>a <s>gone</s> b</p>");
    expect(typed("a `code` b")).toBe("<p>a <code>code</code> b</p>");
  });

  test("inline code keeps the character before it", () => {
    expect(typed("a`b`")).toBe("<p>a<code>b</code></p>");
  });

  test("nothing fires inside a code block", () => {
    const start = doc({ type: "codeBlock", attrs: { language: null }, content: [] });
    expect(typed("# **x**", start)).toBe("<pre><code># **x**</code></pre>");
  });
});
