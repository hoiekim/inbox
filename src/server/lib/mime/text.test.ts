import { describe, expect, it } from "bun:test";
import { textToHtml } from "./text";

describe("textToHtml", () => {
  it("links URLs, www. hosts and addresses, leaving trailing punctuation outside", () => {
    expect(textToHtml("see http://a.example/b... and (www.x.org).")).toBe(
      '<p>see <a href="http://a.example/b">http://a.example/b</a>... and ' +
        '(<a href="http://www.x.org">www.x.org</a>).</p>'
    );
    expect(textToHtml("mail me at a.b+c@d-e.example, ok")).toBe(
      '<p>mail me at <a href="mailto:a.b+c@d-e.example">a.b+c@d-e.example</a>, ok</p>'
    );
    expect(textToHtml("xhttp://no.example a@nodot")).toBe("<p>xhttp://no.example a@nodot</p>");
  });

  it("stays linear on 2 MiB lines built to make a backtracking pattern quadratic", () => {
    const size = 2 * 1024 * 1024;
    const lines = [
      "a".repeat(size),
      "http://a/" + ".".repeat(size) + "x",
      "http://a/x" + ".".repeat(size),
      "x" + " ".repeat(size) + "y",
      "a".repeat(size / 2) + "@" + "b".repeat(size / 2),
      ".".repeat(size)
    ];
    for (const line of lines) {
      const started = performance.now();
      textToHtml(line);
      // Linear work here takes tens of milliseconds; quadratic takes hours.
      expect(performance.now() - started).toBeLessThan(2000);
    }
  });
});
