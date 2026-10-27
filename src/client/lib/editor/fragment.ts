import type { Mark, Node } from "./model";
import { $, type Pos } from "./resolved";
import type { Schema } from "./schema";
import { Transaction, selFrom, selTo } from "./state";
import { build, flatten, toItems, type Token } from "./tokens";
import { deleteRangeInto, type Command } from "./commands";

/**
 * The selected part of a document as whole nodes: textblocks the selection
 * starts or ends inside are cut down to the selected text, and wrappers it
 * spans on both sides are dropped.
 */
export const cut = (doc: Node, from: number, to: number, schema: Schema): Node[] => {
  const tokens = flatten(doc.content ?? [], doc.type, schema).slice(from, to);
  let depth = 0;
  let minDepth = 0;
  for (const t of tokens) {
    if (t.kind === "open") depth++;
    else if (t.kind === "close") {
      depth--;
      minDepth = Math.min(minDepth, depth);
    }
  }
  let openStart = -minDepth;
  let openEnd = depth - minDepth;
  const $from = $(doc, from, schema);
  const prefix: Token[] = [];
  for (let d = $from.depth - openStart + 1; d <= $from.depth; d++) {
    const node = $from.node(d);
    const t: Token = { kind: "open", type: node.type };
    if (node.attrs) t.attrs = node.attrs;
    prefix.push(t);
  }
  const suffix: Token[] = Array.from({ length: openEnd }, () => ({ kind: "close" as const }));
  let nodes = build([...prefix, ...tokens, ...suffix]) ?? [];
  const single = () => nodes.length === 1 && !schema.isTextblock(nodes[0]!.type);
  while (single() && openStart > 1 && openEnd > 1) {
    nodes = nodes[0]!.content ?? [];
    openStart--;
    openEnd--;
  }
  return nodes;
};

const filterMarks = (tokens: Token[], parentType: string, schema: Schema): Token[] =>
  tokens.map((t) => {
    if (t.kind === "char" && t.marks) {
      const marks = t.marks.filter((m: Mark) => schema.allowsMark(parentType, m.type));
      const { marks: _m, ...rest } = t;
      return marks.length ? { ...rest, marks } : rest;
    }
    return t;
  });

const plainText = (nodes: Node[]): string =>
  nodes
    .map((n) => {
      if (n.type === "text") return n.text ?? "";
      if (n.type === "hardBreak") return "\n";
      return n.content ? plainText(n.content) : "";
    })
    .join("");

/**
 * Inserts pasted nodes at the selection, fitting them into the textblock
 * there: inline content goes in as is, and blocks split the textblock with
 * its text joining the first and last of them.
 */
export const insertNodes =
  (nodes: Node[]): Command =>
  (state, dispatch) => {
    const tr = new Transaction(state);
    const from = selFrom(state.selection);
    const to = selTo(state.selection);
    let at = from;
    if (state.selection.node) {
      tr.delete(from, to);
    } else if (from !== to) {
      at = deleteRangeInto(tr, from, to);
    }
    if (!insertAt(tr, at, nodes)) return false;
    dispatch?.(tr.scroll());
    return true;
  };

const insertAt = (tr: Transaction, pos: number, nodes: Node[]): boolean => {
  const schema = tr.schema;
  if (!nodes.length) return false;
  const $pos = $(tr.doc, pos, schema);
  const parent = $pos.parent;
  if (!schema.isTextblock(parent.type)) {
    const items = toItems(flatten(nodes, parent.type, schema));
    if (!tr.maybeStep({ stepType: "replace", from: pos, to: pos, slice: items })) return false;
    const size = Transaction.sliceSize(items);
    tr.setSelection({ anchor: pos + size, head: pos + size });
    return true;
  }

  if (schema.isCode(parent.type)) {
    const allInline = nodes.every((n) => schema.isInline(n.type));
    const lines = allInline
      ? nodes
      : nodes.map((n) => ({ ...n, content: [...(n.content ?? []), schema.text("\n")] }));
    const text = allInline ? plainText(lines) : plainText(lines).replace(/\n$/, "");
    if (!text) return false;
    tr.insertText(text, pos);
    tr.setSelection({ anchor: pos + text.length, head: pos + text.length });
    return true;
  }

  if (nodes.every((n) => schema.isInline(n.type))) {
    const items = toItems(filterMarks(flatten(nodes, parent.type, schema), parent.type, schema));
    if (!items.length) return false;
    if (!tr.maybeStep({ stepType: "replace", from: pos, to: pos, slice: items })) return false;
    const size = Transaction.sliceSize(items);
    tr.setSelection({ anchor: pos + size, head: pos + size });
    return true;
  }

  // At the start of a paragraph the pasted blocks replace it, unless they
  // continue the list the cursor is in; quotes nest there rather than merge.
  const atParagraphStart = parent.type === "paragraph" && $pos.parentOffset === 0;
  return (
    (atParagraphStart && !sharedWrappers(nodes, $pos, true) && replaceParagraph(tr, pos, nodes)) ||
    fitBlocks(tr, pos, nodes, sharedWrappers(nodes, $pos)) ||
    insertAtTop(tr, pos, nodes)
  );
};

/**
 * Pasting at the start of a paragraph replaces it: the pasted blocks keep
 * their own types and the paragraph's text continues the last of them.
 */
const replaceParagraph = (tr: Transaction, pos: number, nodes: Node[]): boolean => {
  const schema = tr.schema;
  const $pos = $(tr.doc, pos, schema);
  const block = $pos.parent;
  const before = $pos.before();
  const parentType = $pos.node($pos.depth - 1).type;
  const last = edgeChain(nodes, schema, "last");
  let head = flatten(nodes, parentType, schema);
  let tail: Token[] = [];
  if (last.textblock) {
    const type = last.textblock.type;
    head = head.slice(0, head.length - last.chain.length - 1);
    const inline = flatten(block.content ?? [], type, schema).filter(
      (t) => !schema.isCode(type) || t.kind === "char"
    );
    tail = [
      ...filterMarks(inline, type, schema),
      ...Array.from({ length: last.chain.length + 1 }, () => ({ kind: "close" as const }))
    ];
  } else if (block.content?.length) {
    tail = flatten([block], parentType, schema);
  }
  const items = toItems([...head, ...tail]);
  if (!tr.maybeStep({ stepType: "replace", from: before, to: $pos.after(), slice: items })) {
    return false;
  }
  const end = before + Transaction.sliceSize(toItems(head));
  if (last.textblock || block.content?.length) tr.setSelection({ anchor: end, head: end });
  else tr.setSelection({ anchor: end - 1, head: end, node: true });
  return true;
};

/** Wrapper chain from the root of `nodes` down to the first (or last) textblock. */
const edgeChain = (nodes: Node[], schema: Schema, side: "first" | "last") => {
  const chain: Node[] = [];
  let node = side === "first" ? nodes[0] : nodes[nodes.length - 1];
  while (node && !schema.isTextblock(node.type) && !schema.isLeaf(node.type)) {
    chain.push(node);
    const children = node.content ?? [];
    node = side === "first" ? children[0] : children[children.length - 1];
  }
  return { chain, textblock: node && schema.isTextblock(node.type) ? node : null };
};

/** Takes the node at `depth` along the first-child chain out of its wrappers. */
const liftFirst = (nodes: Node[], depth: number, schema: Schema): Node[] => {
  if (depth === 0) return nodes;
  const take = (list: Node[], d: number): { taken: Node; rest: Node[] } => {
    if (d === 0) return { taken: list[0]!, rest: list.slice(1) };
    const first = list[0]!;
    const inner = take(first.content ?? [], d - 1);
    let content = inner.rest;
    if (content.length && first.type === "listItem" && content[0]!.type !== "paragraph") {
      content = [schema.node("paragraph"), ...content];
    }
    const remainder = content.length ? [{ ...first, content }] : [];
    return { taken: inner.taken, rest: [...remainder, ...list.slice(1)] };
  };
  const { taken, rest } = take(nodes, depth);
  return [taken, ...rest];
};

const isList = (type: string) => type === "bulletList" || type === "orderedList";

const sameWrapper = (a: string, b: string) => a === b || (isList(a) && isList(b));

/**
 * How many wrappers around the first pasted textblock match the ones around
 * the cursor, innermost first.
 */
const sharedWrappers = (nodes: Node[], $pos: Pos, lists = false): number => {
  const schema = $pos.schema;
  const first = edgeChain(nodes, schema, "first");
  if (!first.textblock) return 0;
  const context = Array.from({ length: $pos.depth - 1 }, (_, i) => $pos.node(i + 1).type);
  const chain = first.chain.map((n) => n.type);
  let matched = 0;
  const max = Math.min(chain.length, context.length);
  while (
    matched < max &&
    sameWrapper(chain[chain.length - 1 - matched]!, context[context.length - 1 - matched]!) &&
    (!lists || context[context.length - 1 - matched] !== "blockquote")
  ) {
    matched++;
  }
  return matched;
};

/**
 * Splits the textblock at the cursor around the pasted blocks: the first
 * pasted textblock's text joins the text before the cursor, the text after
 * the cursor joins the last pasted textblock, and wrappers the pasted
 * content shares with the cursor's (a list item into a list) merge.
 */
const fitBlocks = (tr: Transaction, pos: number, nodes: Node[], shared: number): boolean => {
  const schema = tr.schema;
  const $pos = $(tr.doc, pos, schema);
  const block = $pos.parent;
  const depth = $pos.depth;
  const context = Array.from({ length: depth - 1 }, (_, i) => $pos.node(i + 1));
  const first = edgeChain(nodes, schema, "first");
  let matched = shared;
  const root = first.textblock ? liftFirst(nodes, first.chain.length - matched, schema) : nodes;
  let tokens = flatten(root, $pos.node(depth - 1 - matched).type, schema);
  if (first.textblock) {
    tokens = filterMarksAt(tokens, matched + 1, block.type, schema).slice(matched + 1);
  } else {
    tokens = [{ kind: "close" }, ...tokens];
    matched = 0;
  }
  const last = edgeChain(root, schema, "last");
  const lastDepth = last.chain.length;
  const absorb = !!last.textblock && lastDepth >= matched;
  const tailParent = absorb ? last.textblock!.type : block.type;
  const tailTokens = flatten(block.content ?? [], tailParent, schema)
    .slice($pos.parentOffset)
    .filter((t) => !schema.isCode(tailParent) || t.kind === "char");
  const tail = toItems(filterMarks(tailTokens, tailParent, schema));
  let head: Token[];
  let closes: number;
  if (absorb) {
    let trailing = lastDepth + 1;
    head = tokens.slice();
    while (trailing > 0 && head[head.length - 1]?.kind === "close") {
      head.pop();
      trailing--;
    }
    closes = lastDepth - matched + 1;
  } else {
    const reopen: Token[] = [...context.slice(context.length - matched), block].map((n) => {
      const t: Token = { kind: "open", type: n.type };
      if (n.attrs) t.attrs = n.attrs;
      return t;
    });
    head = [...tokens, ...reopen];
    closes = 1;
  }
  const items = [
    ...toItems(head),
    ...tail,
    ...Array.from({ length: closes }, () => ({ c: 1 as const }))
  ];
  const step = { stepType: "replace" as const, from: pos, to: $pos.after(), slice: items };
  if (!tr.maybeStep(step)) return false;
  const cursorAt = pos + Transaction.sliceSize(toItems(head));
  tr.setSelection({ anchor: cursorAt, head: cursorAt });
  return true;
};

/** Drops marks the cursor's textblock does not allow from the first pasted line. */
const filterMarksAt = (tokens: Token[], skip: number, parentType: string, schema: Schema) => {
  const end = tokens.findIndex((t, i) => i >= skip && t.kind !== "char" && t.kind !== "leaf");
  const head = filterMarks(tokens.slice(0, end < 0 ? tokens.length : end), parentType, schema);
  return end < 0 ? head : [...head, ...tokens.slice(end)];
};

/** Fallback: put the blocks after the top-level block containing `pos`. */
const insertAtTop = (tr: Transaction, pos: number, nodes: Node[]): boolean => {
  const schema = tr.schema;
  const $pos = $(tr.doc, pos, schema);
  if ($pos.depth < 1) return false;
  const after = $pos.after(1);
  const items = toItems(flatten(nodes, "doc", schema));
  if (!tr.maybeStep({ stepType: "replace", from: after, to: after, slice: items })) {
    const text = plainText(nodes);
    if (!text || !schema.isTextblock($pos.parent.type)) return false;
    tr.insertText(text.replace(/\n+/g, " "), pos);
    return true;
  }
  const end = after + Transaction.sliceSize(items);
  tr.setSelection({ anchor: end, head: end });
  return true;
};

/**
 * Plain text as nodes: each line becomes a paragraph and runs of line breaks
 * count as one, so a single line pastes inline.
 */
export const textToNodes = (text: string, schema: Schema, marks?: Mark[]): Node[] => {
  const lines = text.split(/(?:\r\n?|\n)+/);
  const textNode = (line: string) => (line ? [schema.text(line, marks)] : []);
  if (lines.length === 1) return textNode(lines[0]!);
  return lines.map((line) => schema.node("paragraph", undefined, textNode(line)));
};
