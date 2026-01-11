export const processHtmlToSendMail = (html: string) => {
  const div = window.document.createElement("div");
  div.innerHTML = html;
  div.querySelectorAll("*").forEach((e) => {
    const anyE = e as any;
    anyE.style.fontWeight = "normal";
  });
  div.querySelectorAll("p, ul, ol").forEach((e) => {
    const anyE = e as any;
    anyE.style.marginTop = "0.5rem";
    anyE.style.marginBottom = "0.5rem";
  });
  div.querySelectorAll("blockquote").forEach((e) => {
    const anyE = e as any;
    anyE.style.margin = "10px 0 10px 0";
    anyE.style.padding = "0 0 0 0.5rem";
    anyE.style.borderLeft = "5px solid #888";
  });
  div.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((e) => {
    const anyE = e as any;
    anyE.style.fontWeight = "bolder";
  });
  div.querySelectorAll("code").forEach((e) => {
    const anyE = e as any;
    anyE.style.backgroundColor = "#eee";
    anyE.style.color = "#c50";
    anyE.style.borderRadius = "2px";
    anyE.style.fontFamily = "monospace";
    anyE.style.padding = "0 5px";
  });
  div.querySelectorAll("pre").forEach((e) => {
    const anyE = e as any;
    anyE.style.backgroundColor = "#444";
    anyE.style.color = "#fff";
    anyE.style.borderRadius = "3px";
    anyE.style.padding = "0.5rem";
  });
  div.querySelectorAll("pre > code").forEach((e) => {
    const anyE = e as any;
    anyE.style.color = "inherit";
    anyE.style.background = "none";
    anyE.style.padding = 0;
  });
  return div.innerHTML;
};

const replaceBlockquoteWithDetails = (text: string, blockquote: Element) => {
  const details = window.document.createElement("details");
  details.innerHTML =
    "<summary>" +
    text.replace("<", "&lt;").replace(">", "&gt;") +
    "</summary>" +
    "<hr/>" +
    blockquote.innerHTML;
  details.style.marginTop = "16px";
  blockquote.parentNode?.replaceChild(details, blockquote);
  return details;
};

export const processHtmlForViewer = (html: string) => {
  const body = window.document.createElement("body");
  body.innerHTML = html;

  Array.from(body.querySelectorAll("a")).forEach((e) => {
    const target = e.getAttribute("target");
    if (!target || target[0] === "_") e.setAttribute("target", "_blank");
    const text = e.innerText.replaceAll("\\n", " ");
    e.innerText = text.length > 50 ? text.substring(0, 47) + "..." : text;
  });

  Array.from(body.querySelectorAll("div, p, blockquote"))
    .reverse()
    .forEach((e) => {
      const children = Array.from(e.childNodes);
      const firstTextNodeIndex = children.findIndex(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
      );
      // @ts-ignore
      const lastTextNodeIndex = children.findLastIndex(
        // @ts-ignore
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
      );

      const text = children
        .slice(firstTextNodeIndex, lastTextNodeIndex + 1)
        .map((node) => node.textContent)
        .join(" ")
        .trim();

      const regex = /^On.*wrote:/;
      if (regex.test(text)) {
        if (e.nodeName === "BLOCKQUOTE") {
          replaceBlockquoteWithDetails(text, e);
        } else {
          let sibling = e.nextElementSibling;
          while (sibling) {
            if (sibling.matches("blockquote")) break;
            sibling = sibling.nextElementSibling;
          }
          if (sibling && sibling.nodeName === "BLOCKQUOTE") {
            replaceBlockquoteWithDetails(text, sibling);
            e.parentNode?.removeChild(e);
          } else {
            const blockquote = e.querySelector("blockquote");
            if (blockquote) replaceBlockquoteWithDetails(text, blockquote);
          }
        }
        for (let i = firstTextNodeIndex; i <= lastTextNodeIndex; i++) {
          if (children[i]) e.removeChild(children[i]);
        }
      }
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
${body.innerHTML}
`;
};
