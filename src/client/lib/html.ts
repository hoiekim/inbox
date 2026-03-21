import DOMPurify from "dompurify";

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
  // The iframe already has sandbox="allow-same-origin allow-popups" to block
  // script execution, but DOMPurify adds an additional layer of protection
  // against malformed HTML and XSS vectors that bypass sandbox policies.
  const sanitized = DOMPurify.sanitize(html, {
    // Allow inline styles and common email attributes
    ADD_ATTR: ["target", "rel"],
    // Keep style elements (needed for email CSS)
    FORCE_BODY: true,
    // Do not allow data-* attributes (not needed for email viewing)
    ALLOW_DATA_ATTR: false,
  });
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
