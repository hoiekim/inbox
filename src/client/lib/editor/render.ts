import type { Mark } from "./model";
import { markTag } from "./html";
import type { NodeRenderer, RenderSpec } from "./desc";

const el = (tag: string, attrs: Record<string, string | null> = {}): HTMLElement => {
  const dom = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null) dom.setAttribute(k, v);
  return dom;
};

const same = (dom: HTMLElement): RenderSpec => ({ dom, contentDOM: dom });

/** The editable DOM for each node type: the same elements the HTML serializer writes. */
export const nodeRenderers: Record<string, NodeRenderer> = {
  paragraph: () => same(el("p")),
  heading: (node) => same(el(`h${Math.min(6, Math.max(1, Number(node.attrs?.level) || 1))}`)),
  blockquote: () => same(el("blockquote")),
  bulletList: () => same(el("ul")),
  orderedList: (node) => {
    const start = Number(node.attrs?.start);
    const type = node.attrs?.type;
    return same(
      el("ol", {
        start: Number.isFinite(start) && start !== 1 ? String(start) : null,
        type: typeof type === "string" ? type : null
      })
    );
  },
  listItem: () => same(el("li")),
  codeBlock: (node) => {
    const language = node.attrs?.language;
    const code = el("code", { class: language ? `language-${language}` : null });
    const pre = el("pre");
    pre.appendChild(code);
    return { dom: pre, contentDOM: code };
  },
  horizontalRule: () => ({ dom: el("hr") }),
  hardBreak: () => ({ dom: el("br") })
};

export const renderMark = (mark: Mark): RenderSpec => ({ dom: el(markTag(mark)) });
