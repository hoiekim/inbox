import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The parser reads HTML through DOMParser, which needs a DOM; register one for
// this file only.
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const { parseHtml } = await import("./parse-html");
const { docToHtml } = await import("./html");
const { schema } = await import("./schema");

const load = (html: string) => docToHtml({ type: "doc", content: parseHtml(html, schema) });
const paste = (html: string) =>
  docToHtml({ type: "doc", content: parseHtml(html, schema, { paste: true }) });

describe("parseHtml sanitizes", () => {
  test("drops scripts, styles and the like with their content", () => {
    expect(
      load(
        "<p>keep</p><script>alert(1)</script><style>p{}</style><noscript>n</noscript>" +
          "<object>o</object><template><p>t</p></template>"
      )
    ).toBe("<p>keep</p>");
  });

  test("copies no attributes: handlers, styles and links are gone, link text stays", () => {
    expect(
      load(
        '<p onclick="steal()" style="color:red" class="x">a <a href="javascript:alert(1)">b</a> ' +
          '<a href="https://example.com" onmouseover="x()">c</a></p>'
      )
    ).toBe("<p>a b c</p>");
  });

  test("drops images and embedded frames", () => {
    expect(load('<p>a<img onerror="alert(1)">b</p><iframe srcdoc="<p>x</p>"></iframe>')).toBe(
      "<p>ab</p>"
    );
  });

  test("keeps only a plain language name on code blocks", () => {
    expect(load('<pre><code class="language-js" data-x="1">x</code></pre>')).toBe(
      '<pre><code class="language-js">x</code></pre>'
    );
  });
});

describe("parseHtml reads formatting", () => {
  test("marks from tags and inline styles", () => {
    expect(
      load(
        '<p><b>b</b><i>i</i><del>s</del><code>c</code><span style="font-weight:700">w</span>' +
          '<span style="font-style:italic">f</span>' +
          '<span style="text-decoration:line-through">t</span></p>'
      )
    ).toBe(
      "<p><strong>b</strong><em>i</em><s>s</s><code>c</code><strong>w</strong><em>f</em>" +
        "<s>t</s></p>"
    );
  });

  test("a bold tag styled normal is not bold", () => {
    const html =
      '<b style="font-weight:normal">gd</b><strong><span style="font-weight:400">x</span></strong>';
    expect(load(html)).toBe("<p>gdx</p>");
  });

  test("inline code drops other marks", () => {
    expect(load("<p><strong><code>x</code></strong></p>")).toBe("<p><code>x</code></p>");
  });

  test("block structure", () => {
    expect(load("<div>one</div><table><tr><td>A</td><td>B</td></tr></table>")).toBe(
      "<p>one</p><p>AB</p>"
    );
    expect(load("<ul><li>a<ul><li>b</li></ul></li></ul>")).toBe(
      "<ul><li><p>a</p><ul><li><p>b</p></li></ul></li></ul>"
    );
    expect(load('<ol start="3" type="a"><li>x</li></ol>')).toBe(
      '<ol start="3" type="a"><li><p>x</p></li></ol>'
    );
  });

  test("collapses whitespace outside code", () => {
    expect(load("<p>  a \n  b  </p><pre>  c\n  d</pre>")).toBe(
      "<p>a b</p><pre><code>  c\n  d</code></pre>"
    );
  });
});

describe("parseHtml for paste", () => {
  test("drops a trailing line break in a block", () => {
    expect(paste("<p>a<br></p><div>b<br></div>")).toBe("<p>a</p><p>b</p>");
  });

  test("keeps inline content as one paragraph", () => {
    expect(paste('<span style="font-weight:bold">a</span> b')).toBe("<p><strong>a</strong> b</p>");
  });

  test("a list item outside a list is just its content", () => {
    expect(paste("<li>orphan</li>")).toBe("<p>orphan</p>");
  });
});
