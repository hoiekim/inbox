import { sameMark, type Mark, type Node } from "./model";

/**
 * Serializes documents to HTML strings without a DOM. Escaping follows the
 * browser's `innerHTML` serialization, so the output is what reading the
 * rendered element's `innerHTML` would give.
 */

const escapeText = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\u00a0/g, "&nbsp;");

const escapeAttr = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\u00a0/g, "&nbsp;");

const MARK_TAGS: Record<string, string> = {
  bold: "strong",
  italic: "em",
  strike: "s",
  code: "code"
};

export const markTag = (mark: Mark) => MARK_TAGS[mark.type] ?? "span";

const attr = (name: string, value: unknown) =>
  value === null || value === undefined ? "" : ` ${name}="${escapeAttr(String(value))}"`;

/**
 * Inline content, keeping a mark's element open across neighbouring nodes
 * that share it: `<strong>a<em>b</em></strong>`, not two `<strong>`s.
 */
const inlineToHtml = (nodes: readonly Node[]): string => {
  let html = "";
  const open: Mark[] = [];
  for (const node of nodes) {
    const marks = node.marks ?? [];
    let keep = 0;
    while (keep < open.length && keep < marks.length && sameMark(open[keep]!, marks[keep]!)) keep++;
    while (open.length > keep) html += `</${markTag(open.pop()!)}>`;
    for (const mark of marks.slice(keep)) {
      html += `<${markTag(mark)}>`;
      open.push(mark);
    }
    html += node.type === "text" ? escapeText(node.text ?? "") : nodeToHtml(node);
  }
  while (open.length) html += `</${markTag(open.pop()!)}>`;
  return html;
};

export const nodeToHtml = (node: Node): string => {
  const a = node.attrs ?? {};
  const children = node.content ?? [];
  const blocks = () => children.map(nodeToHtml).join("");
  switch (node.type) {
    case "doc":
      return blocks();
    case "text":
      return inlineToHtml([node]);
    case "paragraph":
      return `<p>${inlineToHtml(children)}</p>`;
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(a.level) || 1));
      return `<h${level}>${inlineToHtml(children)}</h${level}>`;
    }
    case "blockquote":
      return `<blockquote>${blocks()}</blockquote>`;
    case "bulletList":
      return `<ul>${blocks()}</ul>`;
    case "orderedList": {
      const start = Number(a.start) === 1 ? null : a.start;
      return `<ol${attr("start", start)}${attr("type", a.type)}>${blocks()}</ol>`;
    }
    case "listItem":
      return `<li>${blocks()}</li>`;
    case "codeBlock": {
      const language = a.language ? `language-${a.language}` : null;
      return `<pre><code${attr("class", language)}>${inlineToHtml(children)}</code></pre>`;
    }
    case "horizontalRule":
      return "<hr>";
    case "hardBreak":
      return "<br>";
    default:
      return node.content ? `<div>${blocks()}</div>` : "";
  }
};

export const docToHtml = (doc: Node) => nodeToHtml(doc);
