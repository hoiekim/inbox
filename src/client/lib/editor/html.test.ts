import { describe, expect, test } from "bun:test";
import type { Mark, Node } from "./model";
import { docToHtml } from "./html";

const text = (t: string, ...marks: string[]): Node =>
  marks.length
    ? { type: "text", text: t, marks: marks.map((type): Mark => ({ type })) }
    : { type: "text", text: t };
const p = (...content: Node[]): Node => ({ type: "paragraph", content });
const doc = (...content: Node[]): Node => ({ type: "doc", content });

describe("docToHtml", () => {
  test("serializes blocks", () => {
    const html = docToHtml(
      doc(
        p(text("para")),
        { type: "heading", attrs: { level: 2 }, content: [text("head")] },
        { type: "blockquote", content: [p(text("quote"))] },
        { type: "bulletList", content: [{ type: "listItem", content: [p(text("item"))] }] },
        { type: "horizontalRule" },
        p()
      )
    );
    expect(html).toBe(
      "<p>para</p><h2>head</h2><blockquote><p>quote</p></blockquote>" +
        "<ul><li><p>item</p></li></ul><hr><p></p>"
    );
  });

  test("writes ordered list start and type only when set", () => {
    const item = { type: "listItem", content: [p(text("x"))] };
    const list = (attrs: Record<string, unknown>) =>
      doc({ type: "orderedList", attrs, content: [item] });
    expect(docToHtml(list({ start: 1, type: null }))).toBe("<ol><li><p>x</p></li></ol>");
    expect(docToHtml(list({ start: 3, type: "a" }))).toBe(
      '<ol start="3" type="a"><li><p>x</p></li></ol>'
    );
  });

  test("writes code blocks with their language", () => {
    const code = { type: "codeBlock", attrs: { language: "js" }, content: [text("a < b\n")] };
    expect(docToHtml(doc(code))).toBe('<pre><code class="language-js">a &lt; b\n</code></pre>');
  });

  test("escapes attribute values so they cannot close the attribute or the tag", () => {
    const language = 'x"><img src=x onerror=alert(1)>';
    const code = { type: "codeBlock", attrs: { language }, content: [text("y")] };
    expect(docToHtml(doc(code))).toBe(
      '<pre><code class="language-x&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">y</code></pre>'
    );
  });

  test("keeps a shared mark open across neighbouring text", () => {
    expect(docToHtml(doc(p(text("a", "bold"), text("b", "bold", "italic"), text("c"))))).toBe(
      "<p><strong>a<em>b</em></strong>c</p>"
    );
    expect(docToHtml(doc(p(text("s", "strike"), text("c", "code"))))).toBe(
      "<p><s>s</s><code>c</code></p>"
    );
  });

  test("keeps marks across a line break", () => {
    const br: Node = { type: "hardBreak", marks: [{ type: "bold" }] };
    expect(docToHtml(doc(p(text("a", "bold"), br, text("b", "bold"))))).toBe(
      "<p><strong>a<br>b</strong></p>"
    );
  });

  test("escapes text like innerHTML does", () => {
    expect(docToHtml(doc(p(text("a & b < c > d \"e\" 'f' g"))))).toBe(
      "<p>a &amp; b &lt; c &gt; d \"e\" 'f'&nbsp;g</p>"
    );
  });
});
