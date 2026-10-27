import { sameMarks, type Attrs, type Mark, type Node } from "./model";
import type { Schema } from "./schema";
import { addToMarkSet } from "./steps";

/**
 * Converts HTML (pasted content, saved drafts, suggested replies) into
 * document nodes. Only the schema's own elements survive: everything else is
 * either unwrapped to its text (`<span>`, `<a>`, `<td>`), treated as a block
 * boundary (`<div>`, `<table>`) or dropped with its content (`<script>`,
 * `<style>`). No attribute is ever copied, so event handlers, links and
 * resource URLs cannot get through.
 */

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "canvas", "dd", "div", "dl", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
  "hgroup", "hr", "li", "noscript", "ol", "output", "p", "pre", "section", "table", "tfoot", "ul"
]);

const IGNORE_TAGS = new Set(["head", "noscript", "object", "script", "style", "title", "template"]);

const INLINE_PARENTS = new Set([
  "a", "abbr", "acronym", "b", "cite", "code", "del", "em", "i", "ins", "kbd", "label", "output",
  "q", "ruby", "s", "samp", "span", "strong", "sub", "sup", "time", "u", "tt", "var"
]);

const WS = /[ \t\r\n\u000c]+/g;

interface BlockRule {
  type: string;
  attrs?: Attrs;
}

const languageOf = (el: Element) => {
  const classes = Array.from(el.firstElementChild?.classList ?? []);
  const language = classes.find((c) => c.startsWith("language-"))?.slice("language-".length);
  return language || null;
};

const blockRule = (el: Element, name: string): BlockRule | null => {
  if (/^h[1-6]$/.test(name)) return { type: "heading", attrs: { level: Number(name[1]) } };
  switch (name) {
    case "p":
      return { type: "paragraph" };
    case "blockquote":
      return { type: "blockquote" };
    case "ul":
      return { type: "bulletList" };
    case "ol": {
      const start = el.hasAttribute("start") ? parseInt(el.getAttribute("start") ?? "", 10) : 1;
      const type = el.getAttribute("type");
      return {
        type: "orderedList",
        attrs: {
          start: Number.isFinite(start) ? start : 1,
          type: type && /^[1aAiI]$/.test(type) ? type : null
        }
      };
    }
    case "li":
      return { type: "listItem" };
    case "pre":
      return { type: "codeBlock", attrs: { language: languageOf(el) } };
    case "hr":
      return { type: "horizontalRule" };
  }
  return null;
};

type MarkChange = { add: string } | { clear: string };

const tagMark = (el: HTMLElement, name: string): string | null => {
  switch (name) {
    case "strong":
      return "bold";
    case "b":
      return el.style.fontWeight === "normal" ? null : "bold";
    case "em":
      return "italic";
    case "i":
      return el.style.fontStyle === "normal" ? null : "italic";
    case "s":
    case "del":
    case "strike":
      return "strike";
    case "code":
      return "code";
  }
  return null;
};

const styleMarks = (el: HTMLElement): MarkChange[] => {
  const style = el.style;
  if (!style || !style.length) return [];
  const changes: MarkChange[] = [];
  const weight = style.getPropertyValue("font-weight");
  if (weight === "400") changes.push({ clear: "bold" });
  else if (/^(bold(er)?|[5-9]\d{2,})$/.test(weight)) changes.push({ add: "bold" });
  const fontStyle = style.getPropertyValue("font-style");
  if (fontStyle === "normal") changes.push({ clear: "italic" });
  else if (fontStyle === "italic") changes.push({ add: "italic" });
  if (style.getPropertyValue("text-decoration").includes("line-through")) {
    changes.push({ add: "strike" });
  }
  return changes;
};

interface Context {
  /** Null for the open root of a paste, which takes any node as it is. */
  type: string | null;
  attrs?: Attrs;
  content: Node[];
  /** Types of the children placed so far, including ones still open. */
  matched: string[];
  /** Opened by an element; leaving it for another context costs extra. */
  solid: boolean;
  preserveWhitespace: boolean;
  /**
   * At the very start of a paste (and each first child down from there): the
   * pasted piece may begin partway into it, so content it would only take
   * after a leading paragraph is accepted as it is.
   */
  openLeft: boolean;
}

export interface ParseOptions {
  /** Clipboard rules: an open root, and a trailing `<br>` in a block is dropped. */
  paste?: boolean;
}

/**
 * The parse keeps a stack of open contexts. When an element ends, its
 * context stays on the stack above `open` until the next node is placed;
 * whitespace handling depends on that, so it is kept rather than closed
 * eagerly.
 */
class Parser {
  private nodes: Context[];
  private open = 0;
  private needsBlock = false;
  private localPreserveWhitespace = false;

  constructor(
    private readonly schema: Schema,
    private readonly options: ParseOptions
  ) {
    const root = options.paste ? null : "doc";
    this.nodes = [
      {
        type: root,
        content: [],
        matched: [],
        solid: true,
        preserveWhitespace: false,
        openLeft: !!options.paste
      }
    ];
  }

  private get top() {
    return this.nodes[this.open]!;
  }

  parse(root: globalThis.Node): Node[] {
    this.addChildren(root, []);
    this.open = 0;
    this.closeExtra();
    const content = this.finish(this.nodes[0]!);
    return this.options.paste ? this.normalizeRoot(content) : content;
  }

  private isList(type: string | null) {
    return type === "bulletList" || type === "orderedList";
  }

  /** Wrapper types a node of `type` needs to sit in `ctx`, or null when it cannot. */
  private route(ctx: Context, type: string): string[] | null {
    const { schema } = this;
    if (ctx.type === null) return [];
    const inline = schema.isInline(type);
    if (schema.isTextblock(ctx.type)) {
      return inline && (type === "text" || !schema.isCode(ctx.type)) ? [] : null;
    }
    if (this.isList(ctx.type)) {
      if (type === "listItem") return [];
      if (type === "paragraph") return ["listItem"];
      return inline ? ["listItem", "paragraph"] : null;
    }
    if (ctx.type === "listItem" && !ctx.matched.length) {
      if (type === "paragraph") return [];
      if (inline) return ["paragraph"];
      return ctx.openLeft && type !== "listItem" ? [] : null;
    }
    if (inline) return ["paragraph"];
    if (type === "listItem") return ["bulletList"];
    return [];
  }

  private finish(ctx: Context): Node[] {
    const { schema } = this;
    const content = mergeText(ctx.content);
    const last = content[content.length - 1];
    if (!ctx.preserveWhitespace && last?.type === "text") {
      const trimmed = trimTrailingWhitespace(last.text!);
      if (trimmed) content[content.length - 1] = { ...last, text: trimmed };
      else content.pop();
    }
    if (ctx.type === null || schema.isTextblock(ctx.type)) return content;
    // A pasted list item that starts partway in gets the paragraph it skipped;
    // one that starts with a list is merged into its parent list later.
    if (ctx.type === "listItem" && content.length && content[0]!.type !== "paragraph") {
      return this.isList(content[0]!.type) ? content : [schema.node("paragraph"), ...content];
    }
    // Containers get the content their schema requires.
    if (content.length) return content;
    if (this.isList(ctx.type)) {
      return [schema.node("listItem", undefined, [schema.node("paragraph")])];
    }
    return [schema.node("paragraph")];
  }

  /** Finishes the contexts above `open` and adds them to their parents. */
  private closeExtra() {
    while (this.nodes.length - 1 > this.open) {
      const ctx = this.nodes.pop()!;
      const parent = this.nodes[this.nodes.length - 1]!;
      parent.content.push(this.schema.node(ctx.type!, ctx.attrs, this.finish(ctx)));
    }
  }

  private sync(to: Context) {
    for (let i = this.open; i >= 0; i--) {
      if (this.nodes[i] === to) {
        this.open = i;
        return true;
      }
    }
    return false;
  }

  private enterInner(type: string, attrs: Attrs | undefined, solid: boolean, code = false) {
    this.closeExtra();
    const top = this.top;
    top.matched.push(type);
    this.nodes.push({
      type,
      attrs: this.schema.attrs(type, attrs),
      content: [],
      matched: [],
      solid,
      preserveWhitespace: code || top.preserveWhitespace,
      openLeft: top.openLeft && !top.content.length
    });
    this.open++;
  }

  /**
   * Makes room for a node of `type`: picks the context, from the top down,
   * that needs the fewest wrappers and opens them. Leaving an element's own
   * context costs extra, and whitespace (`cautious`) never does it.
   */
  private findPlace(type: string, cautious: boolean): boolean {
    let best: { ctx: Context; route: string[] } | null = null;
    let penalty = 0;
    for (let depth = this.open; depth >= 0; depth--) {
      const ctx = this.nodes[depth]!;
      const route = this.route(ctx, type);
      if (route && (!best || best.route.length > route.length + penalty)) {
        best = { ctx, route };
        if (!route.length) break;
      }
      if (ctx.solid) {
        if (cautious) break;
        penalty += 2;
      }
    }
    if (!best) return false;
    this.sync(best.ctx);
    for (const wrapper of best.route) this.enterInner(wrapper, undefined, false);
    return true;
  }

  private insertNode(node: Node, marks: Mark[], cautious: boolean) {
    const { schema } = this;
    if (schema.isInline(node.type) && this.needsBlock && this.top.type === null) {
      this.enterInner("paragraph", undefined, false);
    }
    if (!this.findPlace(node.type, cautious)) return false;
    this.closeExtra();
    const top = this.top;
    top.matched.push(node.type);
    let applied: Mark[] = [];
    for (const mark of marks) {
      if (top.type !== null && !schema.allowsMark(top.type, mark.type)) continue;
      applied = addToMarkSet(applied, mark, schema);
    }
    top.content.push(applied.length ? { ...node, marks: applied } : node);
    return true;
  }

  private addChildren(parent: globalThis.Node, marks: Mark[]) {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) this.addText(child as Text, marks);
      else if (child.nodeType === 1) this.addElement(child as HTMLElement, marks);
    }
  }

  private inlineContext(ctx: Context, dom: globalThis.Node) {
    if (ctx.type !== null) return this.schema.isTextblock(ctx.type);
    if (ctx.content.length) return this.schema.isInline(ctx.content[0]!.type);
    const parent = dom.parentNode?.nodeName.toLowerCase();
    return !!parent && !BLOCK_TAGS.has(parent);
  }

  private addText(dom: Text, marks: Mark[]) {
    const { schema } = this;
    let value = dom.data;
    const top = this.top;
    const full = top.type !== null && schema.isCode(top.type);
    const preserve = full || this.localPreserveWhitespace || top.preserveWhitespace;
    if (!full && !this.inlineContext(top, dom) && !/[^ \t\r\n\u000c]/.test(value)) return;
    if (!preserve) {
      value = value.replace(WS, " ");
      if (value.startsWith(" ") && this.open === this.nodes.length - 1) {
        const before = top.content[top.content.length - 1];
        if (
          !before ||
          dom.previousSibling?.nodeName === "BR" ||
          (before.type === "text" && /[ \t\r\n\u000c]$/.test(before.text!))
        ) {
          value = value.slice(1);
        }
      }
    } else if (full) {
      value = value.replace(/\r\n?/g, "\n");
    } else if (/[\r\n]/.test(value)) {
      // Preserved line breaks become hard breaks.
      value.split(/\r?\n|\r/).forEach((line, i) => {
        if (i) this.insertNode({ type: "hardBreak" }, marks, true);
        if (line) this.insertNode(schema.text(line), marks, !/\S/.test(line));
      });
      return;
    }
    if (value) this.insertNode(schema.text(value), marks, !/\S/.test(value));
  }

  private readStyles(el: HTMLElement, marks: Mark[]) {
    let inner = marks;
    for (const change of styleMarks(el)) {
      if ("clear" in change) inner = inner.filter((m) => m.type !== change.clear);
      else inner = [...inner, this.schema.mark(change.add)];
    }
    return inner;
  }

  private addElement(el: HTMLElement, marks: Mark[]) {
    const name = el.nodeName.toLowerCase();
    const outerPreserve = this.localPreserveWhitespace;
    if (name === "pre" || /pre/.test(el.style?.whiteSpace ?? "")) {
      this.localPreserveWhitespace = true;
    }
    const rule = blockRule(el, name);
    const markType = tagMark(el, name);
    if (IGNORE_TAGS.has(name)) {
      // Dropped with everything inside.
    } else if (name === "br" && this.ignoredBreak(el)) {
      // Still ends the current line: outside a textblock it opens an empty one.
      const top = this.top;
      if (top.type === null || !this.schema.isTextblock(top.type)) this.findPlace("text", false);
    } else if (name === "br") {
      if (!this.insertNode({ type: "hardBreak" }, marks, true)) this.leafFallback(el, marks);
    } else if (rule) {
      if (this.isList(rule.type)) nestStrayLists(el);
      this.addBlock(el, rule, this.readStyles(el, marks));
    } else if (markType) {
      this.addChildren(el, [...this.readStyles(el, marks), this.schema.mark(markType)]);
    } else if (BLOCK_TAGS.has(name)) {
      this.addUnknownBlock(el, this.readStyles(el, marks));
    } else if (el.firstChild) {
      this.addChildren(el, this.readStyles(el, marks));
    }
    this.localPreserveWhitespace = outerPreserve;
  }

  /** A line break that fits nowhere else is a newline in the text. */
  private leafFallback(el: HTMLElement, marks: Mark[]) {
    const top = this.top;
    if (top.type && this.schema.isTextblock(top.type) && el.parentNode) {
      this.addText(el.ownerDocument.createTextNode("\n"), marks);
    }
  }

  private ignoredBreak(el: HTMLElement) {
    if (!this.options.paste || el.nextSibling || !el.parentNode) return false;
    return !INLINE_PARENTS.has(el.parentNode.nodeName.toLowerCase());
  }

  private addBlock(el: HTMLElement, rule: BlockRule, marks: Mark[]) {
    const { schema } = this;
    if (schema.isLeaf(rule.type)) {
      this.insertNode(schema.node(rule.type, rule.attrs), marks, false);
      return;
    }
    let entered = false;
    if (this.findPlace(rule.type, false)) {
      this.enterInner(rule.type, rule.attrs, true, schema.isCode(rule.type));
      entered = true;
    }
    const startIn = this.top;
    this.addChildren(el, marks);
    if (entered) {
      this.sync(startIn);
      this.open = Math.max(0, this.open - 1);
    }
  }

  /** `<div>`, `<table>` and friends: their content starts and ends a block. */
  private addUnknownBlock(el: HTMLElement, marks: Mark[]) {
    let top = this.top;
    const outerNeedsBlock = this.needsBlock;
    const first = top.content[0];
    if (first && this.schema.isInline(first.type) && this.open) {
      this.open--;
      top = this.top;
    }
    if (top.type === null) this.needsBlock = true;
    this.addChildren(el, marks);
    this.sync(top);
    this.needsBlock = outerNeedsBlock;
  }

  /**
   * Shapes an open root into blocks: runs of inline content become
   * paragraphs, and a list item outside any list gives up its content.
   */
  private normalizeRoot(nodes: Node[]): Node[] {
    const { schema } = this;
    if (nodes.every((n) => schema.isInline(n.type))) {
      return nodes.length ? [schema.node("paragraph", undefined, nodes)] : [];
    }
    const out: Node[] = [];
    let run: Node[] = [];
    const flush = () => {
      if (run.length) out.push(schema.node("paragraph", undefined, mergeText(run)));
      run = [];
    };
    for (const node of nodes) {
      if (schema.isInline(node.type)) {
        run.push(node);
        continue;
      }
      flush();
      out.push(...(node.type === "listItem" ? node.content ?? [] : [node]));
    }
    flush();
    if (out[0] && this.isList(out[0].type)) out[0] = this.liftLeadingList(out[0]);
    return out;
  }

  /**
   * A pasted list whose first item starts with a nested list (an item cut
   * open before its text) takes that nested list's items in its place.
   */
  private liftLeadingList(list: Node): Node {
    const [first, ...rest] = list.content ?? [];
    const nested = first?.content?.[0];
    if (!first || !nested || !this.isList(nested.type)) return list;
    const lifted = this.liftLeadingList(nested).content ?? [];
    const remainder = (first.content ?? []).slice(1);
    if (remainder.length && lifted.length) {
      const last = lifted[lifted.length - 1]!;
      lifted[lifted.length - 1] = { ...last, content: [...(last.content ?? []), ...remainder] };
    }
    return { ...list, content: [...lifted, ...rest] };
  }
}

const trimTrailingWhitespace = (text: string) => {
  let end = text.length;
  while (end > 0 && " \t\r\n\f".includes(text[end - 1]!)) end--;
  return text.substring(0, end);
};

const mergeText = (nodes: Node[]): Node[] => {
  const out: Node[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (last?.type === "text" && node.type === "text" && sameMarks(last.marks, node.marks)) {
      out[out.length - 1] = { ...last, text: last.text! + node.text! };
    } else {
      out.push(node);
    }
  }
  return out;
};

/** A list directly inside a list belongs to the item before it. */
const nestStrayLists = (list: Element) => {
  let previousItem: Element | null = null;
  for (let child = list.firstChild; child; child = child.nextSibling) {
    const name = child.nodeType === 1 ? child.nodeName.toLowerCase() : null;
    if ((name === "ul" || name === "ol") && previousItem) {
      previousItem.appendChild(child);
      child = previousItem;
    } else if (name === "li") {
      previousItem = child as Element;
    } else if (name) {
      previousItem = null;
    }
  }
};

/** Table parts outside a table are dropped by the HTML parser unless wrapped. */
const TABLE_WRAPPERS: Record<string, string[]> = {
  thead: ["table"],
  tbody: ["table"],
  tfoot: ["table"],
  caption: ["table"],
  colgroup: ["table"],
  col: ["table", "colgroup"],
  tr: ["table", "tbody"],
  td: ["table", "tbody", "tr"],
  th: ["table", "tbody", "tr"]
};

/** Clipboard HTML, read as a fragment into an inert document. */
const parseFragment = (html: string): HTMLElement => {
  const source = html.replace(/^(\s*<meta [^>]*>)*/, "");
  const first = /<([a-z][^>\s]+)/i.exec(source)?.[1]?.toLowerCase();
  const wrap = (first && TABLE_WRAPPERS[first]) || [];
  const doc = document.implementation.createHTMLDocument("");
  let el: HTMLElement = doc.createElement("div");
  const open = wrap.map((n) => `<${n}>`).join("");
  const close = [...wrap].reverse().map((n) => `</${n}>`).join("");
  el.innerHTML = open + source + close;
  for (const tag of wrap) el = el.querySelector<HTMLElement>(tag) ?? el;
  return el;
};

/** Stored or generated HTML, read as a document body. */
const parseBody = (html: string) =>
  new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;

/** Whitespace-only text nodes that only indent markup (`"\n"`, `"\n  "`). */
const dropIndentation = (node: globalThis.Node) => {
  for (let child = node.lastChild; child; ) {
    const previous = child.previousSibling;
    if (child.nodeType === 3 && /^(\n\s\s|\n)$/.test(child.nodeValue ?? "")) {
      node.removeChild(child);
    }
    else if (child.nodeType === 1) dropIndentation(child);
    child = previous;
  }
};

/** Parses HTML into the block content of a document. */
export const parseHtml = (html: string, schema: Schema, options: ParseOptions = {}): Node[] => {
  const root = options.paste ? parseFragment(html) : parseBody(html);
  if (!options.paste) dropIndentation(root);
  return new Parser(schema, options).parse(root);
};

export const htmlToDoc = (html: string, schema: Schema): Node => ({
  type: "doc",
  content: parseHtml(html, schema)
});
