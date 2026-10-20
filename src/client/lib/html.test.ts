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

describe("processHtmlForViewer — Referer-beacon vectors (issue #1003)", () => {
  test("meta referrer=no-referrer is the first thing in the built document", () => {
    expect(
      processHtmlForViewer(`<p>x</p>`).startsWith(
        '<meta name="referrer" content="no-referrer">'
      )
    ).toBe(true);
  });

  test("meta referrer is placed ahead of the <html> tag in the built document", () => {
    // happy-dom's parser does not implement the spec's before-<head> foster
    // parenting, so assert on the string: the meta is the document's first
    // token, which puts it in <head> in a real browser parser.
    const out = processHtmlForViewer(`<p>x</p>`);
    expect(out.indexOf('<meta name="referrer"')).toBe(0);
    expect(out.indexOf("<html")).toBeGreaterThan(0);
  });

  test("strips a mail-authored <meta name=referrer> so it cannot override the viewer policy", () => {
    const doc = viewerDoc(
      `<head><meta name="referrer" content="unsafe-url"></head><p>x</p>`
    );
    const metas = Array.from(doc.querySelectorAll("meta[name=referrer]"));
    expect(metas).toHaveLength(1);
    expect(metas[0]!.getAttribute("content")).toBe("no-referrer");
  });

  test("drops <link rel=stylesheet> outright", () => {
    const doc = viewerDoc(
      `<link rel="stylesheet" href="https://x.test/a.css"><p>hi</p>`
    );
    expect(doc.querySelector("link")).toBeNull();
    expect(doc.body.textContent).toContain("hi");
  });

  test("strips @import and url() from <style> but keeps the rest of the CSS", () => {
    const doc = viewerDoc(
      `<style id="mail">@import url("https://x.test/a.css"); p { color: red; background-image: url("https://x.test/bg.png"); margin: 0; }</style>`
    );
    const css = doc.querySelector("style#mail")?.textContent ?? "";
    expect(css).not.toContain("@import");
    expect(css).not.toContain("url(");
    expect(css).toContain("color: red");
    expect(css).toContain("margin: 0");
  });

  test("strips @import with a bare string URL", () => {
    const doc = viewerDoc(
      `<style id="mail">@import "https://x.test/a.css"; p { color: red; }</style>`
    );
    const css = doc.querySelector("style#mail")?.textContent ?? "";
    expect(css).not.toContain("@import");
    expect(css).not.toContain("x.test");
    expect(css).toContain("color: red");
  });

  test("strips background-image url() from an inline style, keeping other declarations", () => {
    const doc = viewerDoc(
      `<p style="color: blue; background-image: url('https://x.test/bg.png')">x</p>`
    );
    const style = doc.querySelector("p")?.getAttribute("style") ?? "";
    expect(style).not.toContain("url(");
    expect(style).not.toContain("x.test");
    expect(style).toContain("color: blue");
  });

  test("removes an inline style attribute left empty after stripping", () => {
    const doc = viewerDoc(
      `<p style="background-image:url(https://x.test/bg.png)">x</p>`
    );
    expect(doc.querySelector("p")?.hasAttribute("style")).toBe(false);
  });

  test("keeps an inline style with no remote references untouched", () => {
    const doc = viewerDoc(`<p style="color: blue; margin: 0">x</p>`);
    const style = doc.querySelector("p")?.getAttribute("style") ?? "";
    expect(style).toContain("color: blue");
    expect(style).toContain("margin: 0");
  });

  test.each([
    ["input", "src", `<input type="image" src="javascript:alert(1)">`],
    ["video", "poster", `<video poster="javascript:alert(1)">`],
    ["table", "background", `<table background="javascript:alert(1)">`]
  ] as const)("strips javascript: in %s on <%s>", (_tag, attrName, html) => {
    const doc = viewerDoc(html);
    expect(doc.body.innerHTML).not.toContain("javascript:");
    const el = doc.querySelector(_tag);
    expect(el?.hasAttribute(attrName)).toBe(false);
  });

  test("keeps https poster and background", () => {
    const doc = viewerDoc(
      `<video poster="https://x.test/p.png"><table background="https://x.test/b.png">`
    );
    expect(doc.querySelector("video")?.getAttribute("poster")).toBe(
      "https://x.test/p.png"
    );
    expect(doc.querySelector("table")?.getAttribute("background")).toBe(
      "https://x.test/b.png"
    );
  });

  test("keeps https input type=image src", () => {
    const doc = viewerDoc(
      `<input type="image" src="https://x.test/go.png">`
    );
    expect(doc.querySelector("input")?.getAttribute("src")).toBe(
      "https://x.test/go.png"
    );
  });

  test("strips javascript: hiding in a later srcset candidate", () => {
    const doc = viewerDoc(
      `<img srcset="https://x.test/a.png 1x, javascript:alert(1) 2x">`
    );
    expect(doc.querySelector("img")?.hasAttribute("srcset")).toBe(false);
  });

  test("keeps a clean srcset", () => {
    const srcset = "https://x.test/a.png 1x, https://x.test/b.png 2x";
    const doc = viewerDoc(`<img srcset="${srcset}">`);
    expect(doc.querySelector("img")?.getAttribute("srcset")).toBe(srcset);
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
