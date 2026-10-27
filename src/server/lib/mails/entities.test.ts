import { describe, expect, it } from "bun:test";
import { decodeEntities } from "./entities";

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
