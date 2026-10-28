import { describe, expect, it } from "bun:test";
import { decodeAttributeEntities, decodeEntities } from "./entities";

describe("decodeEntities", () => {
  it("decodes named references", () => {
    expect(decodeEntities("&amp; &lt; &gt; &quot; &apos; &nbsp; &copy; &hellip; &euro;")).toBe(
      "& < > \" '   © … €"
    );
  });

  it("decodes legacy names without a semicolon, keeping the next character", () => {
    expect(decodeEntities("&amp &ampx; a=1&copy=2 &lt3 &frac12x")).toBe("& &x; a=1©=2 <3 ½x");
  });

  it("decodes decimal and hexadecimal references", () => {
    expect(decodeEntities("&#65;&#x42;&#X43;&#68 &#x1F600;")).toBe("ABCD 😀");
  });

  it("remaps references the HTML parser treats specially", () => {
    expect(decodeEntities("&#0; &#150; &#xD800; &#99999999;")).toBe("� – � �");
  });

  it("leaves anything else as written", () => {
    expect(decodeEntities("&; & &#; &#x; AT&T &unknown; &check;")).toBe(
      "&; & &#; &#x; AT&T &unknown; &check;"
    );
  });
});

describe("decodeAttributeEntities", () => {
  it("decodes only references closed by a semicolon", () => {
    expect(decodeAttributeEntities("?a=1&amp;b=2&#38;c&#x26;d")).toBe("?a=1&b=2&c&d");
    expect(decodeAttributeEntities("?a=1&copy=2&amp=3&#38x")).toBe("?a=1&copy=2&amp=3&#38x");
    expect(decodeAttributeEntities("&notaname;")).toBe("&notaname;");
  });
});
