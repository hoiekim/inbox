import { decodeEntities } from "./entities";

/**
 * Plain-text rendering of mail HTML: block elements start new lines, text
 * wraps at 80 columns, headings are uppercased, list items get ` * ` or
 * `1. ` prefixes, quotes get `> `, links keep only their text, and images,
 * scripts, styles and comments are dropped.
 *
 * Markup is read the lenient way mail clients write it, with no attempt at
 * full HTML5 tree construction: a few elements close their open siblings
 * (`<p>`, `<li>`, `<td>`...), void elements never take children, and a
 * stray end tag closes back to its matching start tag or is ignored.
 */

interface Element {
  name: string;
  attribs: Record<string, string>;
  children: DomNode[];
  parent: Element | null;
}

/** Comments and declarations: they hold no text but still count as list children. */
type Other = { other: true };

type DomNode = Element | { text: string } | Other;

const isElement = (node: DomNode): node is Element => "name" in node;
const isText = (node: DomNode): node is { text: string } => "text" in node;

const P = new Set(["p"]);
const FORM = new Set(["input", "option", "optgroup", "select", "button", "datalist", "textarea"]);

/** Opening one of these closes the listed elements when they are the innermost open one. */
const OPEN_IMPLIES_CLOSE: Record<string, Set<string>> = {
  tr: new Set(["tr", "th", "td"]),
  th: new Set(["th"]),
  td: new Set(["thead", "th", "td"]),
  body: new Set(["head", "link", "script"]),
  li: new Set(["li"]),
  option: new Set(["option"]),
  optgroup: new Set(["optgroup", "option"]),
  dd: new Set(["dt", "dd"]),
  dt: new Set(["dt", "dd"]),
  rt: new Set(["rt", "rp"]),
  rp: new Set(["rt", "rp"]),
  tbody: new Set(["thead", "tbody"]),
  tfoot: new Set(["thead", "tbody"])
};
for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6", "address", "article", "aside",
  "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form",
  "header", "hr", "main", "nav", "ol", "pre", "section", "table", "ul", "p"]) {
  OPEN_IMPLIES_CLOSE[tag] = P;
}
for (const tag of ["select", "input", "output", "button", "datalist", "textarea"]) {
  OPEN_IMPLIES_CLOSE[tag] = FORM;
}

const VOID = new Set([
  "area", "base", "basefont", "br", "col", "command", "embed", "frame", "hr", "img", "input",
  "isindex", "keygen", "link", "meta", "param", "source", "track", "wbr"
]);

/** Inside these, `<x/>` closes itself. */
const FOREIGN = new Set(["math", "svg"]);
const HTML_INTEGRATION = new Set([
  "mi", "mo", "mn", "ms", "mtext", "annotation-xml", "foreignObject", "desc", "title"
]);

/** Elements whose content is raw text up to their end tag. */
const RAW_TEXT = new Set(["script", "style", "title"]);

/** Content kept out of the text entirely. */
const SKIPPED = new Set(["script", "style"]);

const isSpace = (c: string) => c === " " || c === "\n" || c === "\t" || c === "\f" || c === "\r";
const isAlpha = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");

/** Builds the element tree from tokenizer events. */
class TreeBuilder {
  readonly root: Element = { name: "", attribs: {}, children: [], parent: null };
  private current = this.root;
  private open: string[] = [];
  private foreign: boolean[] = [];
  private lastText: { text: string } | null = null;
  private tagName = "";
  private attribs: Record<string, string> = {};

  text(data: string) {
    if (this.lastText) {
      this.lastText.text += data;
      return;
    }
    this.lastText = { text: data };
    this.current.children.push(this.lastText);
  }

  /** A comment, CDATA section, declaration or processing instruction. */
  other() {
    this.current.children.push({ other: true });
    this.lastText = null;
  }

  openTagName(raw: string) {
    const name = raw.toLowerCase();
    this.tagName = name;
    const implied = OPEN_IMPLIES_CLOSE[name];
    if (implied) {
      while (this.open.length && implied.has(this.open[this.open.length - 1]!)) {
        this.closeTag(this.open[this.open.length - 1]!);
      }
    }
    if (!VOID.has(name)) {
      this.open.push(name);
      if (FOREIGN.has(name)) this.foreign.push(true);
      else if (HTML_INTEGRATION.has(name)) this.foreign.push(false);
    }
    this.attribs = {};
  }

  attribute(name: string, value: string) {
    const key = name.toLowerCase();
    if (!(key in this.attribs)) this.attribs[key] = value;
  }

  openTagEnd() {
    const name = this.tagName;
    const element: Element = { name, attribs: this.attribs, children: [], parent: this.current };
    this.current.children.push(element);
    this.current = element;
    this.lastText = null;
    if (VOID.has(name)) this.popElement();
    this.tagName = "";
  }

  selfClosingTag() {
    if (this.foreign[this.foreign.length - 1]) this.closeCurrentTag();
    else this.openTagEnd();
  }

  private closeCurrentTag() {
    const name = this.tagName;
    this.openTagEnd();
    if (this.open[this.open.length - 1] === name) {
      this.popElement();
      this.open.pop();
    }
  }

  private popElement() {
    this.current = this.current.parent ?? this.root;
    this.lastText = null;
  }

  closeTag(raw: string) {
    const name = raw.toLowerCase();
    if (FOREIGN.has(name) || HTML_INTEGRATION.has(name)) this.foreign.pop();
    if (this.open.length && !VOID.has(name)) {
      const index = this.open.lastIndexOf(name);
      if (index !== -1) {
        for (let n = this.open.length - index; n > 0; n--) {
          this.open.pop();
          this.popElement();
        }
      } else if (name === "p") {
        this.openTagName(name);
        this.closeCurrentTag();
      }
    } else if (name === "br" || name === "p") {
      this.openTagName(name);
      this.closeCurrentTag();
    }
  }

  end() {
    while (this.open.length) {
      this.open.pop();
      this.popElement();
    }
  }
}

const enum State {
  Text,
  BeforeTagName,
  InTagName,
  BeforeClosingTagName,
  InClosingTagName,
  AfterClosingTagName,
  BeforeAttributeName,
  InSelfClosingTag,
  InAttributeName,
  AfterAttributeName,
  BeforeAttributeValue,
  InAttributeValueDq,
  InAttributeValueSq,
  InAttributeValueNq,
  BeforeDeclaration,
  InDeclaration,
  InProcessingInstruction,
  BeforeComment,
  InComment,
  InSpecialComment,
  AfterComment1,
  AfterComment2,
  BeforeCdata,
  InCdata,
  AfterCdata1,
  AfterCdata2
}

/** States where trailing input is part of an unfinished tag and dropped. */
const TAG_STATES = new Set([
  State.InTagName,
  State.BeforeAttributeName,
  State.BeforeAttributeValue,
  State.AfterAttributeName,
  State.InAttributeName,
  State.InAttributeValueSq,
  State.InAttributeValueDq,
  State.InAttributeValueNq,
  State.InClosingTagName
]);

const COMMENT_STATES = new Set([
  State.InComment,
  State.AfterComment1,
  State.AfterComment2,
  State.InCdata,
  State.AfterCdata1,
  State.AfterCdata2
]);

/** One pass over the input, character by character. */
const tokenize = (html: string, tree: TreeBuilder) => {
  let state = State.Text;
  let sectionStart = 0;
  let rawText: string | null = null;
  let attribName = "";
  let cdataMatched = 0;
  let i = 0;
  const section = () => html.substring(sectionStart, i);

  for (; i < html.length; i++) {
    const c = html[i]!;
    switch (state) {
      case State.Text:
        if (c === "<") {
          if (i > sectionStart) tree.text(section());
          state = State.BeforeTagName;
          sectionStart = i;
        }
        break;
      case State.BeforeTagName:
        if (c === "/") {
          state = State.BeforeClosingTagName;
        } else if (c === "<") {
          tree.text(section());
          sectionStart = i;
        } else if (c === ">" || rawText !== null || isSpace(c)) {
          state = State.Text;
        } else if (c === "!") {
          state = State.BeforeDeclaration;
          sectionStart = i + 1;
        } else if (c === "?") {
          state = State.InProcessingInstruction;
          sectionStart = i + 1;
        } else if (!isAlpha(c)) {
          state = State.Text;
        } else {
          state = State.InTagName;
          sectionStart = i;
        }
        break;
      case State.InTagName:
        if (c === "/" || c === ">" || isSpace(c)) {
          const name = section();
          tree.openTagName(name);
          if (RAW_TEXT.has(name.toLowerCase())) rawText = name.toLowerCase();
          sectionStart = -1;
          state = State.BeforeAttributeName;
          i--;
        }
        break;
      case State.BeforeClosingTagName:
        if (isSpace(c)) {
          // Ignored.
        } else if (c === ">") {
          state = State.Text;
        } else if (rawText !== null) {
          // Inside raw text only the element's own end tag counts.
          const end = rawTextEnd(html, i, rawText);
          if (end.matched) {
            rawText = null;
            state = State.InClosingTagName;
            sectionStart = i;
          } else {
            state = State.Text;
          }
          i = end.next - 1;
        } else if (!isAlpha(c)) {
          state = State.InSpecialComment;
          sectionStart = i;
        } else {
          state = State.InClosingTagName;
          sectionStart = i;
        }
        break;
      case State.InClosingTagName:
        if (c === ">" || isSpace(c)) {
          tree.closeTag(section());
          sectionStart = -1;
          state = State.AfterClosingTagName;
          i--;
        }
        break;
      case State.AfterClosingTagName:
        if (c === ">") {
          state = State.Text;
          sectionStart = i + 1;
        }
        break;
      case State.BeforeAttributeName:
        if (c === ">") {
          tree.openTagEnd();
          state = State.Text;
          sectionStart = i + 1;
        } else if (c === "/") {
          state = State.InSelfClosingTag;
        } else if (!isSpace(c)) {
          state = State.InAttributeName;
          sectionStart = i;
        }
        break;
      case State.InSelfClosingTag:
        if (c === ">") {
          tree.selfClosingTag();
          state = State.Text;
          sectionStart = i + 1;
          rawText = null;
        } else if (!isSpace(c)) {
          state = State.BeforeAttributeName;
          i--;
        }
        break;
      case State.InAttributeName:
        if (c === "=" || c === "/" || c === ">" || isSpace(c)) {
          attribName = section();
          sectionStart = -1;
          state = State.AfterAttributeName;
          i--;
        }
        break;
      case State.AfterAttributeName:
        if (c === "=") {
          state = State.BeforeAttributeValue;
        } else if (c === "/" || c === ">") {
          tree.attribute(attribName, "");
          state = State.BeforeAttributeName;
          i--;
        } else if (!isSpace(c)) {
          tree.attribute(attribName, "");
          state = State.InAttributeName;
          sectionStart = i;
        }
        break;
      case State.BeforeAttributeValue:
        if (c === '"') {
          state = State.InAttributeValueDq;
          sectionStart = i + 1;
        } else if (c === "'") {
          state = State.InAttributeValueSq;
          sectionStart = i + 1;
        } else if (!isSpace(c)) {
          state = State.InAttributeValueNq;
          sectionStart = i;
          i--;
        }
        break;
      case State.InAttributeValueDq:
      case State.InAttributeValueSq:
        if (c === (state === State.InAttributeValueDq ? '"' : "'")) {
          tree.attribute(attribName, section());
          sectionStart = -1;
          state = State.BeforeAttributeName;
        }
        break;
      case State.InAttributeValueNq:
        if (isSpace(c) || c === ">") {
          tree.attribute(attribName, section());
          sectionStart = -1;
          state = State.BeforeAttributeName;
          i--;
        }
        break;
      case State.BeforeDeclaration:
        if (c === "[") {
          state = State.BeforeCdata;
          cdataMatched = 0;
        } else {
          state = c === "-" ? State.BeforeComment : State.InDeclaration;
        }
        break;
      case State.BeforeCdata:
        if (cdataMatched < 5 && c.toUpperCase() === "CDATA"[cdataMatched]) {
          cdataMatched++;
        } else if (cdataMatched === 5 && c === "[") {
          state = State.InCdata;
          sectionStart = i + 1;
        } else {
          state = State.InDeclaration;
          i--;
        }
        break;
      case State.InDeclaration:
      case State.InProcessingInstruction:
        if (c === ">") {
          tree.other();
          state = State.Text;
          sectionStart = i + 1;
        }
        break;
      case State.BeforeComment:
        if (c === "-") {
          state = State.InComment;
          sectionStart = i + 1;
        } else {
          state = State.InDeclaration;
        }
        break;
      case State.InComment:
        if (c === "-") state = State.AfterComment1;
        break;
      case State.InSpecialComment:
        if (c === ">") {
          tree.other();
          state = State.Text;
          sectionStart = i + 1;
        }
        break;
      case State.AfterComment1:
        state = c === "-" ? State.AfterComment2 : State.InComment;
        break;
      case State.AfterComment2:
        if (c === ">") {
          tree.other();
          state = State.Text;
          sectionStart = i + 1;
        } else if (c !== "-") {
          state = State.InComment;
        }
        break;
      case State.InCdata:
        if (c === "]") state = State.AfterCdata1;
        break;
      case State.AfterCdata1:
        state = c === "]" ? State.AfterCdata2 : State.InCdata;
        break;
      case State.AfterCdata2:
        if (c === ">") {
          tree.other();
          state = State.Text;
          sectionStart = i + 1;
        } else if (c !== "]") {
          state = State.InCdata;
        }
        break;
    }
  }

  if (sectionStart >= 0 && sectionStart < html.length) {
    if (COMMENT_STATES.has(state)) tree.other();
    else if (!TAG_STATES.has(state)) tree.text(html.substring(sectionStart));
  }
  tree.end();
};

/**
 * Reads a possible end tag for raw text at `index` (just after `</`). On a
 * match, `next` is the end of the name; otherwise it is where text reading
 * resumes, which depends on how far the name matched.
 */
const rawTextEnd = (html: string, index: number, name: string) => {
  let n = 0;
  while (n < name.length && html[index + n]?.toLowerCase() === name[n]) n++;
  if (n === name.length) {
    const after = html[index + n];
    if (after !== undefined && (after === ">" || isSpace(after))) {
      return { matched: true, next: index + n };
    }
    return { matched: false, next: Math.min(html.length, index + n + 1) };
  }
  // A wrong second letter of "script"/"style" is consumed; other mismatches are reread.
  const consumed = n === 1 && name !== "title" ? 1 : 0;
  return { matched: false, next: Math.min(html.length, index + n + consumed) };
};

const WORDWRAP = 80;
/** HTML whitespace, plus the zero-width space. */
const WHITESPACE = " \t\r\n\f\u200b";
const isWhitespace = (c: string | undefined) => c !== undefined && WHITESPACE.includes(c);
const WORD = /[^ \t\r\n\f\u200b]+/g;
const HAS_WORD = /[^ \t\r\n\f\u200b]/;

/** Collects words into lines no longer than `maxLineLength`. */
class LineBuilder {
  lines: string[][] = [];
  words: string[] = [];
  available: number;
  stashedSpace = false;
  wordBreakOpportunity = false;

  constructor(readonly maxLineLength: number) {
    this.available = maxLineLength;
  }

  pushWord(word: string) {
    if (this.available <= 0) this.startNewLine();
    const lineStart = this.words.length === 0;
    const cost = word.length + (lineStart ? 0 : 1);
    if (cost <= this.available) {
      this.words.push(word);
      this.available -= cost;
      return;
    }
    // Wrap before a word that does not fit; one longer than a line stays whole.
    if (!lineStart) this.startNewLine();
    this.words.push(word);
    this.available -= word.length;
  }

  popWord() {
    const word = this.words.pop();
    if (word !== undefined) this.available += word.length + (this.words.length ? 1 : 0);
    return word;
  }

  concatWord(word: string) {
    if (this.wordBreakOpportunity && word.length > this.available) {
      this.pushWord(word);
      this.wordBreakOpportunity = false;
    } else {
      const last = this.popWord();
      this.pushWord(last ? last + word : word);
    }
  }

  startNewLine(n = 1) {
    this.lines.push(this.words);
    for (let i = 1; i < n; i++) this.lines.push([]);
    this.words = [];
    this.available = this.maxLineLength;
  }

  isEmpty() {
    return this.lines.length === 0 && this.words.length === 0;
  }

  clear() {
    this.lines = [];
    this.words = [];
    this.available = this.maxLineLength;
  }

  toString() {
    return [...this.lines, this.words].map((words) => words.join(" ")).join("\n");
  }
}

class Block {
  readonly lines: LineBuilder;
  rawText = "";
  stashedLineBreaks = 0;
  isPre: boolean;

  constructor(
    readonly parent: Block | null,
    public leadingLineBreaks: number,
    maxLineLength: number
  ) {
    this.lines = new LineBuilder(maxLineLength);
    this.isPre = !!parent?.isPre;
  }

  text() {
    return this.lines.isEmpty() ? this.rawText : this.rawText + this.lines.toString();
  }

  /** Appends a finished child block's text with the line breaks between them. */
  append(text: string, leadingLineBreaks: number, trailingLineBreaks: number) {
    const current = this.text();
    const lineBreaks = Math.max(this.stashedLineBreaks, leadingLineBreaks);
    this.lines.clear();
    if (current) {
      this.rawText = current + "\n".repeat(lineBreaks) + text;
    } else {
      this.rawText = text;
      this.leadingLineBreaks = lineBreaks;
    }
    this.stashedLineBreaks = trailingLineBreaks;
  }
}

type Transform = (word: string) => string;

class TextBuilder {
  private block = new Block(null, 1, WORDWRAP);
  private transforms: Transform[] = [];

  pushTransform(transform: Transform) {
    this.transforms.push(transform);
  }

  popTransform() {
    this.transforms.pop();
  }

  lineBreak() {
    if (this.block.isPre) this.block.rawText += "\n";
    else this.block.lines.startNewLine();
  }

  wordBreakOpportunity() {
    this.block.lines.wordBreakOpportunity = true;
  }

  addInline(text: string) {
    const block = this.block;
    if (block.isPre) {
      block.rawText += text;
      return;
    }
    if (!text.length) return;
    if (block.stashedLineBreaks && !HAS_WORD.test(text)) return;
    if (block.stashedLineBreaks) block.lines.startNewLine(block.stashedLineBreaks);
    this.shrinkWrapAdd(text, block.lines);
    block.stashedLineBreaks = 0;
  }

  /** Collapses whitespace runs to single spaces while adding words. */
  private shrinkWrapAdd(text: string, lines: LineBuilder) {
    const transform = (word: string) =>
      this.transforms.reduceRight((w, t) => t(w), word);
    const stashed = lines.stashedSpace;
    let any = false;
    WORD.lastIndex = 0;
    let match = WORD.exec(text);
    if (match) {
      any = true;
      if (stashed || isWhitespace(text[0])) lines.pushWord(transform(match[0]));
      else lines.concatWord(transform(match[0]));
      while ((match = WORD.exec(text)) !== null) lines.pushWord(transform(match[0]));
    }
    lines.stashedSpace = (stashed && !any) || isWhitespace(text[text.length - 1]);
  }

  openBlock({ leadingLineBreaks = 1, reservedLineLength = 0, isPre = false } = {}) {
    const maxLineLength = Math.max(20, this.block.lines.maxLineLength - reservedLineLength);
    this.block = new Block(this.block, leadingLineBreaks, maxLineLength);
    if (isPre) this.block.isPre = true;
  }

  closeBlock({
    trailingLineBreaks = 1,
    blockTransform
  }: { trailingLineBreaks?: number; blockTransform?: (text: string) => string } = {}) {
    const block = this.block;
    this.block = block.parent!;
    const text = blockTransform ? blockTransform(block.text()) : block.text();
    this.block.append(
      text,
      block.leadingLineBreaks,
      Math.max(block.stashedLineBreaks, trailingLineBreaks)
    );
  }

  toString() {
    return this.block.text();
  }
}

const trimNewlines = (text: string) => text.replace(/^\n+|\n+$/g, "");

const letterSequence = (n: number, base: string) => {
  const digits: number[] = [];
  do {
    n -= 1;
    digits.push(n % 26);
    n = Math.floor(n / 26);
  } while (n > 0);
  return digits
    .reverse()
    .map((d) => String.fromCharCode(base.charCodeAt(0) + d))
    .join("");
};

const ROMAN_ONES = ["I", "X", "C", "M"];
const ROMAN_FIVES = ["V", "L", "D"];

const roman = (n: number) =>
  [...String(n)]
    .map(Number)
    .reverse()
    .map((v, i) =>
      v % 5 < 4
        ? (v < 5 ? "" : ROMAN_FIVES[i]) + ROMAN_ONES[i]!.repeat(v % 5)
        : ROMAN_ONES[i]! + (v < 5 ? ROMAN_FIVES[i] : ROMAN_ONES[i + 1])
    )
    .reverse()
    .join("");

const listMarker = (type: string | undefined): ((n: number) => string) => {
  switch (type) {
    case "a":
      return (n) => letterSequence(n, "a");
    case "A":
      return (n) => letterSequence(n, "A");
    case "i":
      return (n) => roman(n).toLowerCase();
    case "I":
      return (n) => roman(n);
    default:
      return (n) => String(n);
  }
};

const BLOCKS = new Set([
  "article", "aside", "div", "footer", "form", "header", "main", "nav", "section"
]);

const upper = (word: string) => word.toUpperCase();

const walk = (nodes: DomNode[], builder: TextBuilder) => {
  for (const node of nodes) {
    if (isText(node)) builder.addInline(decodeEntities(node.text));
    else if (isElement(node) && !SKIPPED.has(node.name)) format(node, builder);
  }
};

const format = (el: Element, builder: TextBuilder) => {
  const { name } = el;
  if (BLOCKS.has(name)) {
    builder.openBlock();
    walk(el.children, builder);
    builder.closeBlock();
    return;
  }
  switch (name) {
    case "img":
      return;
    case "br":
      builder.lineBreak();
      return;
    case "wbr":
      builder.wordBreakOpportunity();
      return;
    case "p":
    case "table":
      builder.openBlock({ leadingLineBreaks: 2 });
      walk(el.children, builder);
      builder.closeBlock({ trailingLineBreaks: 2 });
      return;
    case "pre":
      builder.openBlock({ leadingLineBreaks: 2, isPre: true });
      walk(el.children, builder);
      builder.closeBlock({ trailingLineBreaks: 2 });
      return;
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      builder.openBlock({ leadingLineBreaks: name <= "h3" ? 3 : 2 });
      builder.pushTransform(upper);
      walk(el.children, builder);
      builder.popTransform();
      builder.closeBlock({ trailingLineBreaks: 2 });
      return;
    case "hr":
      builder.openBlock({ leadingLineBreaks: 2 });
      builder.addInline("-".repeat(WORDWRAP));
      builder.closeBlock({ trailingLineBreaks: 2 });
      return;
    case "blockquote":
      builder.openBlock({ leadingLineBreaks: 2, reservedLineLength: 2 });
      walk(el.children, builder);
      builder.closeBlock({
        trailingLineBreaks: 2,
        blockTransform: (text) =>
          trimNewlines(text)
            .split("\n")
            .map((line) => "> " + line)
            .join("\n")
      });
      return;
    case "ul":
      formatList(el, builder, () => " * ");
      return;
    case "ol": {
      let index = Number(el.attribs.start || "1");
      const marker = listMarker(el.attribs.type);
      formatList(el, builder, () => " " + marker(index++) + ". ");
      return;
    }
    default:
      walk(el.children, builder);
  }
};

const formatList = (el: Element, builder: TextBuilder, nextPrefix: () => string) => {
  const nested = el.parent?.name === "li";
  let maxPrefixLength = 0;
  const items = el.children
    .filter((child) => !isText(child) || !/^\s*$/.test(child.text))
    .map((node) => {
      if (!isElement(node) || node.name !== "li") return { node, prefix: "" };
      const prefix = nested ? nextPrefix().trimStart() : nextPrefix();
      maxPrefixLength = Math.max(maxPrefixLength, prefix.length);
      return { node, prefix };
    });
  if (!items.length) return;
  const spacing = "\n" + " ".repeat(maxPrefixLength);
  builder.openBlock({ leadingLineBreaks: nested ? 1 : 2 });
  for (const { node, prefix } of items) {
    builder.openBlock({ leadingLineBreaks: 1, reservedLineLength: maxPrefixLength });
    walk([node], builder);
    builder.closeBlock({
      trailingLineBreaks: 1,
      blockTransform: (text) =>
        prefix + " ".repeat(maxPrefixLength - prefix.length) + text.replace(/\n/g, spacing)
    });
  }
  builder.closeBlock({ trailingLineBreaks: nested ? 1 : 2 });
};

/** `<body>` elements when there are any, else the whole document. */
const findBodies = (nodes: DomNode[], found: Element[] = []) => {
  for (const node of nodes) {
    if (!isElement(node) || SKIPPED.has(node.name)) continue;
    if (node.name === "body") found.push(node);
    else findBodies(node.children, found);
  }
  return found;
};

/** Longer input is cut off; the text of a 16 MiB mail is not worth more. */
const MAX_INPUT_LENGTH = 1 << 24;

export const htmlToPlainText = (html: string): string => {
  const tree = new TreeBuilder();
  tokenize(html.length > MAX_INPUT_LENGTH ? html.substring(0, MAX_INPUT_LENGTH) : html, tree);
  const bodies = findBodies(tree.root.children);
  const builder = new TextBuilder();
  walk(bodies.length ? bodies : tree.root.children, builder);
  return builder.toString();
};
