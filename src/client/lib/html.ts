/**
 * Strip dangerous elements and attributes from an HTML string using
 * DOMParser — no external library required.
 *
 * The email viewer already runs inside a sandboxed iframe without
 * `allow-scripts`, so JS cannot execute regardless. This function is
 * defense-in-depth: it removes script tags, event handlers, and
 * dangerous URI schemes before the HTML is injected into the iframe.
 * The iframe uses `allow-popups allow-popups-to-escape-sandbox` so that
 * links opened in new tabs escape the sandbox and render normally.
 */
const sanitizeEmailHtml = (html: string): string => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  // Remove elements that can execute code or load external resources silently
  const dangerous = ["script", "iframe", "object", "embed", "applet", "base"];
  dangerous.forEach((tag) => {
    doc.querySelectorAll(tag).forEach((el) => el.remove());
  });

  // Strip dangerous attributes on every element
  const DANGEROUS_ATTR = /^on/i; // onclick, onerror, onload, ...
  const DANGEROUS_URI = /^\s*(javascript|vbscript|data):/i;
  doc.querySelectorAll("*").forEach((el) => {
    Array.from(el.attributes).forEach((attr) => {
      if (DANGEROUS_ATTR.test(attr.name)) {
        el.removeAttribute(attr.name);
      } else if (
        (attr.name === "href" || attr.name === "src" || attr.name === "action") &&
        DANGEROUS_URI.test(attr.value)
      ) {
        el.removeAttribute(attr.name);
      }
    });
  });

  return doc.documentElement.outerHTML;
};

export const processHtmlToSendMail = (html: string) => {
  const div = window.document.createElement("div");
  div.innerHTML = html;
  div.querySelectorAll("*").forEach((e) => {
    if (e instanceof HTMLElement) {
      e.style.fontWeight = "normal";
    }
  });
  div.querySelectorAll("p").forEach((e) => {
    if (!e.innerText.trim()) {
      const br = window.document.createElement("br");
      e.parentNode?.replaceChild(br, e);
    }
  });
  div.querySelectorAll("p, ul, ol").forEach((e) => {
    const htmlE = e as HTMLElement;
    htmlE.style.marginTop = "0.5rem";
    htmlE.style.marginBottom = "0.5rem";
  });
  div.querySelectorAll("blockquote").forEach((e) => {
    e.style.margin = "10px 0 10px 0";
    e.style.padding = "0 0 0 0.5rem";
    e.style.borderLeft = "5px solid #888";
  });
  div.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((e) => {
    const heading = e as HTMLHeadingElement;
    heading.style.fontWeight = "bolder";
  });
  div.querySelectorAll("code").forEach((e) => {
    e.style.backgroundColor = "#eee";
    e.style.color = "#c50";
    e.style.borderRadius = "2px";
    e.style.fontFamily = "monospace";
    e.style.padding = "0 5px";
  });
  div.querySelectorAll("pre").forEach((e) => {
    e.style.backgroundColor = "#444";
    e.style.color = "#fff";
    e.style.borderRadius = "3px";
    e.style.padding = "0.5rem";
  });
  div.querySelectorAll("pre > code").forEach((e) => {
    const htmlE = e as HTMLElement;
    htmlE.style.color = "inherit";
    htmlE.style.background = "none";
    htmlE.style.padding = "0";
  });
  return div.innerHTML;
};

export const processHtmlForViewer = (html: string) => {
  // Sanitize HTML as defense-in-depth before rendering in iframe.
  // The iframe has sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
  // to block script execution while allowing links to open in new tabs normally.
  // This stripping adds an extra layer against script tags, event handlers,
  // and dangerous URI schemes.
  const sanitized = sanitizeEmailHtml(html);
  return `
<style>
  body {
      margin: 0;
      overflow: hidden;
      width: 100%;
      height: 100%
  }
  * {
      font-family: "Open Sans", -apple-system, BlinkMacSystemFont, "Segoe UI",
      "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans",
      "Helvetica Neue", sans-serif;
      color: rgb(70,70,70);
  }
</style>
${sanitized}
`;
};
