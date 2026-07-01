import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// html.ts's sanitizer relies on DOMParser + window.document, which bun's
// runtime does not provide. Register happy-dom for this file only (and tear it
// down in afterAll) so the DOM globals don't leak into the server suites, which
// deliberately run without a DOM.
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

// sanitizeEmailHtml is not exported; processHtmlForViewer is its only public
// caller, so the contract is exercised through it. The returned string wraps
// the sanitized markup in a <style> block for the iframe srcdoc — re-parse it
// and assert on the DOM.
const { processHtmlForViewer } = await import("./html");

/** Sanitize `html`, then re-parse the viewer output into a queryable document. */
const viewerDoc = (html: string): Document =>
  new DOMParser().parseFromString(processHtmlForViewer(html), "text/html");

describe("processHtmlForViewer — dangerous element stripping", () => {
  const dangerousTags = ["script", "iframe", "object", "embed", "applet", "base"];

  test.each(dangerousTags)("removes <%s>", (tag) => {
    const doc = viewerDoc(`<div>keep me</div><${tag}></${tag}>`);
    expect(doc.querySelector(tag)).toBeNull();
    // benign sibling survives
    expect(doc.body.textContent).toContain("keep me");
  });

  test("removes a <script> even with inline JS payload", () => {
    const doc = viewerDoc(`<p>hi</p><script>window.stolen = document.cookie</script>`);
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.body.textContent).toContain("hi");
  });
});

describe("processHtmlForViewer — event-handler attribute stripping", () => {
  test.each(["onerror", "onload", "onclick", "onmouseover"])("removes %s", (attr) => {
    const doc = viewerDoc(`<img src="https://x.test/a.png" ${attr}="steal()">`);
    const img = doc.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.hasAttribute(attr)).toBe(false);
  });

  test("keeps a non-event attribute untouched", () => {
    const doc = viewerDoc(`<a href="https://x.test" title="ok">link</a>`);
    const a = doc.querySelector("a");
    expect(a?.getAttribute("title")).toBe("ok");
    expect(a?.getAttribute("href")).toBe("https://x.test");
  });
});

describe("processHtmlForViewer — dangerous URI scheme neutralization", () => {
  test.each(["href", "src", "action", "xlink:href", "formaction"])(
    "strips javascript: in %s",
    (attrName) => {
      const doc = viewerDoc(`<a ${attrName}="javascript:alert(1)">x</a>`);
      const el = doc.querySelector("a");
      expect(el?.hasAttribute(attrName)).toBe(false);
    },
  );

  test("strips javascript: in an SVG-namespaced xlink:href", () => {
    const doc = viewerDoc(`<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>`);
    expect(doc.querySelector("a")?.hasAttribute("xlink:href")).toBe(false);
  });

  test("strips vbscript: in href", () => {
    const doc = viewerDoc(`<a href="vbscript:msgbox(1)">x</a>`);
    expect(doc.querySelector("a")?.hasAttribute("href")).toBe(false);
  });

  test("strips leading-whitespace-obfuscated javascript: scheme", () => {
    const doc = viewerDoc(`<a href="  javascript:alert(1)">x</a>`);
    expect(doc.querySelector("a")?.hasAttribute("href")).toBe(false);
  });

  test("strips data: in href (HTML data: URIs can execute)", () => {
    const doc = viewerDoc(`<a href="data:text/html,<script>alert(1)</script>">x</a>`);
    expect(doc.querySelector("a")?.hasAttribute("href")).toBe(false);
  });

  test("keeps data: in <img src> (inert as an image source)", () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";
    const doc = viewerDoc(`<img src="${src}">`);
    expect(doc.querySelector("img")?.getAttribute("src")).toBe(src);
  });

  test("still strips javascript: in <img src>", () => {
    const doc = viewerDoc(`<img src="javascript:alert(1)">`);
    expect(doc.querySelector("img")?.hasAttribute("src")).toBe(false);
  });

  test("keeps a safe https href", () => {
    const doc = viewerDoc(`<a href="https://safe.test/path">x</a>`);
    expect(doc.querySelector("a")?.getAttribute("href")).toBe("https://safe.test/path");
  });
});

describe("processHtmlForViewer — image tracking mitigation", () => {
  test("adds referrerpolicy=no-referrer and loading=lazy to a bare <img>", () => {
    const img = viewerDoc(`<img src="https://x.test/a.png">`).querySelector("img");
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img?.getAttribute("loading")).toBe("lazy");
  });

  test("does not overwrite an author-provided loading attribute", () => {
    const img = viewerDoc(`<img src="https://x.test/a.png" loading="eager">`).querySelector("img");
    expect(img?.getAttribute("loading")).toBe("eager");
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });
});

describe("processHtmlForViewer — output shape", () => {
  test("wraps sanitized markup with the viewer <style> block", () => {
    const out = processHtmlForViewer(`<p>body text</p>`);
    expect(out).toContain("<style>");
    expect(out).toContain("font-family");
    expect(out).toContain("body text");
  });

  test("preserves benign structural content", () => {
    const doc = viewerDoc(`<h1>Title</h1><p>Para <strong>bold</strong></p><ul><li>item</li></ul>`);
    expect(doc.querySelector("h1")?.textContent).toBe("Title");
    expect(doc.querySelector("strong")?.textContent).toBe("bold");
    expect(doc.querySelector("li")?.textContent).toBe("item");
  });
});
