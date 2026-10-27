import type { Attrs, Mark } from "./model";
import { $ } from "./resolved";
import { Transaction, type EditorState } from "./state";
import { StepError } from "./steps";
import { descendants, nodeSize, nodesToItems } from "./tokens";
import { marksAt } from "./commands";

/**
 * Markdown-style shortcuts that fire as text is typed: `# ` for a heading,
 * `- ` or `1. ` for a list, `> ` for a quote, ```` ``` ```` for a code block,
 * `---` for a rule, and `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``.
 */
type Handler = (
  state: EditorState,
  match: RegExpMatchArray,
  from: number,
  to: number
) => Transaction;

interface InputRule {
  match: RegExp;
  handler: Handler;
}

/** Matched text is the start of its textblock; the block becomes `type`. */
const textblockRule = (match: RegExp, type: string, attrs: (m: RegExpMatchArray) => Attrs) => ({
  match,
  handler: (state: EditorState, m: RegExpMatchArray, from: number, to: number) => {
    const tr = new Transaction(state);
    tr.delete(from, to);
    const $pos = $(tr.doc, from, state.schema);
    const blockPos = $pos.before();
    const size = nodeSize($pos.parent, state.schema);
    tr.step({
      stepType: "replaceAround",
      from: blockPos,
      to: blockPos + size,
      gapFrom: blockPos + 1,
      gapTo: blockPos + size - 1,
      slice: [{ o: type, a: state.schema.attrs(type, attrs(m)) }, { c: 1 }],
      insert: 1
    });
    tr.setSelection({ anchor: from, head: from });
    return tr;
  }
});

/**
 * Wraps the textblock in `outer` (and `item`), joining a directly preceding
 * wrapper of the same type when `join` allows it.
 */
const wrappingRule = (
  match: RegExp,
  outer: string,
  item: string | null,
  attrs: (m: RegExpMatchArray) => Attrs | undefined,
  join: (m: RegExpMatchArray, before: { childCount: number; attrs?: Attrs }) => boolean
): InputRule => ({
  match,
  handler: (state, m, from, to) => {
    const { schema } = state;
    const tr = new Transaction(state);
    tr.delete(from, to);
    const $pos = $(tr.doc, from, schema);
    const blockPos = $pos.before();
    const end = $pos.after();
    const outerAttrs = schema.attrs(outer, attrs(m));
    const open = outerAttrs ? { o: outer, a: outerAttrs } : { o: outer };
    const close = { c: 1 as const };
    const slice = item ? [open, { o: item }, close, close] : [open, close];
    tr.step({
      stepType: "replaceAround",
      from: blockPos,
      to: end,
      gapFrom: blockPos,
      gapTo: end,
      slice,
      insert: item ? 2 : 1
    });
    const depth = $pos.depth - 1;
    const container = $pos.node(depth);
    const before = container.content?.[$pos.index(depth) - 1];
    const cursor = blockPos + (item ? 2 : 1) + (from - blockPos);
    tr.setSelection({ anchor: cursor, head: cursor });
    if (before?.type === outer) {
      const childCount = before.content?.length ?? 0;
      if (join(m, { childCount, attrs: before.attrs })) {
        tr.delete(blockPos - 1, blockPos + 1);
        tr.setSelection({ anchor: cursor - 2, head: cursor - 2 });
      }
    }
    return tr;
  }
});

/** `lead` + delimiter + inner text + delimiter: the inner text gets the mark. */
const markRule = (match: RegExp, type: string, delimiter: number): InputRule => ({
  match,
  handler: (state, m, from, to) => {
    const inner = m[2]!;
    const start = from + m[1]!.length;
    const innerEnd = start + delimiter + inner.length;
    const excluded = (marks: Mark[] | undefined) =>
      !!marks?.some((mark) => mark.type !== type && state.schema.excludes(mark.type, type));
    let blocked = false;
    descendants(state.doc, state.schema, (node, pos) => {
      if (pos + nodeSize(node, state.schema) <= start || pos >= to) return false;
      if (excluded(node.marks)) blocked = true;
      return !blocked;
    });
    if (blocked) throw new StepError(`${type} is excluded here`);
    const tr = new Transaction(state);
    tr.delete(innerEnd, to);
    tr.delete(start, start + delimiter);
    tr.addMark(start, start + inner.length, state.schema.mark(type));
    const end = start + inner.length;
    tr.setSelection({ anchor: end, head: end });
    const after = { ...state, doc: tr.doc, selection: tr.selection, storedMarks: null };
    tr.setStoredMarks(marksAt(after).filter((mark) => mark.type !== type));
    return tr;
  }
});

const always = () => true;

/** Inserts a rule before the textblock and removes the typed text. */
const horizontalRule: InputRule = {
  match: /^(?:---|\u2014-|___\s|\*\*\*\s)$/,
  handler: (state, _m, from, to) => {
    const tr = new Transaction(state);
    const blockPos = $(state.doc, from, state.schema).before();
    tr.replace(blockPos, blockPos, nodesToItems([{ type: "horizontalRule" }], state.schema));
    tr.delete(from + 1, to + 1);
    tr.setSelection({ anchor: from + 1, head: from + 1 });
    return tr;
  }
};

const inputRules: InputRule[] = [
  markRule(/(^|\s)\*\*(?!\s+\*\*)([^*]+)\*\*(?!\s+\*\*)$/, "bold", 2),
  markRule(/(^|\s)__(?!\s+__)([^_]+)__(?!\s+__)$/, "bold", 2),
  wrappingRule(/^\s*>\s$/, "blockquote", null, () => undefined, always),
  wrappingRule(/^\s*([-+*])\s$/, "bulletList", "listItem", () => undefined, always),
  markRule(/(^|[^`])`([^`]+)`$/, "code", 1),
  textblockRule(/^```([a-z]+)?[\s\n]$/, "codeBlock", (m) => ({ language: m[1] ?? null })),
  textblockRule(/^~~~([a-z]+)?[\s\n]$/, "codeBlock", (m) => ({ language: m[1] ?? null })),
  textblockRule(/^(#{1,6})\s$/, "heading", (m) => ({ level: m[1]!.length })),
  horizontalRule,
  markRule(/(^|\s)\*(?!\s+\*)([^*]+)\*(?!\s+\*)$/, "italic", 1),
  markRule(/(^|\s)_(?!\s+_)([^_]+)_(?!\s+_)$/, "italic", 1),
  wrappingRule(
    /^(\d+)\.\s$/,
    "orderedList",
    "listItem",
    (m) => ({ start: Number(m[1]) }),
    (m, before) => before.childCount + Number(before.attrs?.start ?? 1) === Number(m[1])
  ),
  markRule(/(^|\s)~~(?!\s+~~)([^~]+)~~(?!\s+~~)$/, "strike", 2)
];

/** How much text before the cursor the rules look at. */
const MAX_MATCH = 500;

/**
 * Runs input rules for the text just before `cursor`. Returns the first
 * matching rule's transaction, or null.
 */
export const runInputRules = (state: EditorState, cursor: number): Transaction | null => {
  const { schema, doc } = state;
  const $pos = $(doc, cursor, schema);
  const parent = $pos.parent;
  if (!schema.isTextblock(parent.type) || schema.isCode(parent.type)) return null;
  if (marksAt({ ...state, storedMarks: null }).some((m) => m.type === "code")) return null;
  let textBefore = "";
  let offset = $pos.start();
  for (const child of parent.content ?? []) {
    if (offset >= cursor) break;
    const size = nodeSize(child, schema);
    const take = Math.min(size, cursor - offset);
    textBefore += child.type === "text" ? child.text!.slice(0, take) : "\n";
    offset += size;
  }
  textBefore = textBefore.slice(-MAX_MATCH);
  for (const rule of inputRules) {
    const m = textBefore.match(rule.match);
    if (!m) continue;
    try {
      return rule.handler(state, m, cursor - m[0].length, cursor).setMeta("inputRule", true);
    } catch (e) {
      if (e instanceof StepError || e instanceof RangeError) continue;
      throw e;
    }
  }
  return null;
};
