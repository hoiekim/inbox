import { describe, expect, it } from "bun:test";
import { htmlToPlainText } from "./plain-text";

describe("htmlToPlainText", () => {
  const cases: [string, string, string][] = [
    [
      "separates paragraphs and keeps line breaks",
      "<p>First</p><p>Second<br>line</p>text after",
      "First\n\nSecond\nline\n\ntext after"
    ],
    [
      "uppercases headings",
      "<h1>Title</h1><h4>Small heading</h4><p>body</p>",
      "TITLE\n\nSMALL HEADING\n\nbody"
    ],
    [
      "prefixes list items, nested lists indented",
      "<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>",
      " * one\n * two\n   * nested"
    ],
    [
      "numbers ordered lists from start, in the given style",
      '<ol start="3"><li>c</li><li>d</li></ol><ol type="I"><li>x</li><li>y</li><li>z</li>' +
        '<li>w</li></ol><ol type="a"><li>p</li></ol>',
      " 3. c\n 4. d\n\n I.   x\n II.  y\n III. z\n IV.  w\n\n a. p"
    ],
    [
      "prefixes quoted lines",
      "<p>On Monday someone wrote:</p><blockquote><p>quoted</p><p>more</p></blockquote>",
      "On Monday someone wrote:\n\n> quoted\n> \n> more"
    ],
    [
      "wraps at 80 columns",
      "<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor " +
        "incididunt ut labore et dolore magna aliqua.</p>",
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor\n" +
        "incididunt ut labore et dolore magna aliqua."
    ],
    [
      "puts a word longer than a line on its own line",
      "<p>short https://example.com/a/very/long/path/that/keeps/going/and/going/past/eighty/" +
        "columns end</p>",
      "short\nhttps://example.com/a/very/long/path/that/keeps/going/and/going/past/eighty/" +
        "columns\nend"
    ],
    ["keeps whitespace in pre", "<pre>  a\n    b  c</pre><p>after</p>", "  a\n    b  c\n\nafter"],
    [
      "runs table cells together",
      "<table><tr><td>Name</td><td>Qty</td></tr><tr><td>Apple</td><td>3</td></tr></table>",
      "NameQtyApple3"
    ],
    [
      "closes open items and paragraphs",
      "<ul><li>one<li>two</ul><p>a<p>b",
      " * one\n * two\n\na\n\nb"
    ],
    [
      "drops scripts, styles, comments and images",
      "<style>p{color:red}</style><p>a<!-- hidden -->b<img src=x alt=pic></p>" +
        "<script>var s = '<p>no</p>';</script>",
      "ab"
    ],
    [
      "reads only the body when there is one",
      "<html><head><title>Subject</title></head><body><p>Body</p></body></html>",
      "Body"
    ],
    ["reads everything without a body", "<title>Subject</title><p>Body</p>", "Subject\n\nBody"],
    [
      "keeps only link text",
      '<p>Visit <a href="https://example.com">our site</a>.</p>',
      "Visit our site."
    ],
    ["draws a horizontal rule", "<p>a</p><hr><p>b</p>", `a\n\n${"-".repeat(80)}\n\nb`],
    ["collapses whitespace", "<p>  Too   many \n\t spaces  </p>", "Too many spaces"],
    [
      "ends script content only at its own end tag",
      "<script>if (a</b) {}</scr ipt></script>after",
      "after"
    ],
    ["turns stray end tags into elements or nothing", "</p>x</br>y</div>z", "\n\nx\nyz"],
    [
      "decodes character references",
      "<p>&lt;a&gt; &amp; &quot;q&quot; &#169; &#x263A; caf&eacute; AT&T &copy=1</p>",
      '<a> & "q" © ☺ café AT&T ©=1'
    ]
  ];

  for (const [name, html, text] of cases) {
    it(name, () => {
      expect(htmlToPlainText(html)).toBe(text);
    });
  }

  it("drops link targets and images unless asked for URLs", () => {
    const html = '<p>Verify: <a href="https://bit.ly/3abc">now</a><img src="a.png" alt="A"></p>';
    expect(htmlToPlainText(html)).toBe("Verify: now");
    expect(htmlToPlainText(html, { urls: true })).toBe(
      "Verify: now [https://bit.ly/3abc]A [a.png]"
    );
  });

  it("shows link targets and image sources with urls", () => {
    const cases: [string, string][] = [
      ['<a href="https://x.org">https://x.org</a>', "https://x.org [https://x.org]"],
      ['<a href="mailto:a@b.c">write</a> <a href="mailto:a@b.c"></a>', "write [a@b.c] a@b.c"],
      ['<a href="#top">top</a> <a href="">empty</a> <a>none</a>', "top empty none"],
      [
        '<a href="https://x.org/?a=1&amp;b=2&copy=3&#38;c">q</a>',
        "q [https://x.org/?a=1&b=2&copy=3&c]"
      ],
      [
        '<img src="cid:logo@x" alt="Logo"> <img src="y.png"> <img alt="alt">',
        "Logo [cid:logo@x] [y.png] alt"
      ],
      ['<h1><a href="https://x.org/h">link</a></h1>', "LINK [https://x.org/h]"]
    ];
    for (const [html, text] of cases) expect(htmlToPlainText(html, { urls: true })).toBe(text);
  });

  it("handles unterminated markup at the end of input", () => {
    expect(htmlToPlainText("text <")).toBe("text <");
    expect(htmlToPlainText("<p>a<!-- open")).toBe("a");
    expect(htmlToPlainText('<p>a</p><div class="x')).toBe("a");
  });

  it("stays linear on long runs of line breaks, newlines and references", () => {
    // Quadratic handling of any of these takes seconds to minutes at this size.
    const inputs = [
      `<blockquote><p>a</p>${"<br>".repeat(100_000)}<p>b</p></blockquote>`,
      `<blockquote><pre>a${"\n".repeat(400_000)}b</pre></blockquote>`,
      "<blockquote>" +
        "&#".repeat(200_000) +
        "&amp;".repeat(100_000) +
        "&notit;".repeat(50_000) +
        "</blockquote>"
    ];
    for (const html of inputs) {
      const started = performance.now();
      const text = htmlToPlainText(html);
      expect(performance.now() - started).toBeLessThan(3000);
      expect(text.startsWith("> ")).toBe(true);
    }
  });

  it("converts large input", () => {
    const row = "<tr><td>cell <b>bold</b> &amp; text</td></tr>";
    const text = htmlToPlainText(`<table>${row.repeat(50000)}</table>`);
    expect(text.startsWith("cell bold & textcell bold")).toBe(true);
    expect(text.length).toBeGreaterThan(50000 * 15);
  });
});
