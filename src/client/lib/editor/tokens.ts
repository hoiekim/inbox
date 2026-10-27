import { sameMarks, type Attrs, type Mark, type Node } from "./model";
import type { Schema } from "./schema";

/**
 * Documents are addressed by integer positions over a flat token view of the
 * tree: entering or leaving a non-leaf node costs one position, each UTF-16
 * code unit of text costs one, and each leaf node costs one. Position 0 is
 * the start of the document's content.
 *
 * Edits are expressed as splices of that token stream, so one primitive
 * covers typing, deleting, splitting and joining blocks. The splice is
 * applied to the smallest subtree that stays balanced, so an edit inside a
 * paragraph only re-tokenizes that paragraph.
 */

export type Token =
  | { kind: "open"; type: string; attrs?: Attrs; marks?: Mark[] }
  | { kind: "close" }
  | { kind: "char"; ch: string; marks?: Mark[]; parent: string }
  | { kind: "leaf"; node: Node; parent: string };

/** Serializable form of a token run, used in steps. */
export type SliceItem =
  | { o: string; a?: Attrs; m?: Mark[] }
  | { c: 1 }
  | { t: string; m?: Mark[] }
  | { n: Node };

export const nodeSize = (node: Node, schema: Schema): number => {
  if (node.type === "text") return node.text?.length ?? 0;
  if (schema.isLeaf(node.type)) return 1;
  return 2 + contentSize(node, schema);
};

export const contentSize = (node: Node, schema: Schema): number => {
  let size = 0;
  for (const child of node.content ?? []) size += nodeSize(child, schema);
  return size;
};

export const sliceSize = (items: readonly SliceItem[]): number => {
  let size = 0;
  for (const item of items) size += "t" in item ? item.t.length : 1;
  return size;
};

const withMarks = <T extends object>(base: T, marks?: Mark[]): T =>
  marks?.length ? { ...base, marks } : base;

export const flatten = (
  nodes: readonly Node[],
  parent: string,
  schema: Schema,
  out: Token[] = []
) => {
  for (const node of nodes) {
    if (node.type === "text") {
      const text = node.text ?? "";
      for (let i = 0; i < text.length; i++) {
        out.push(withMarks({ kind: "char" as const, ch: text[i]!, parent }, node.marks));
      }
    } else if (schema.isLeaf(node.type)) {
      out.push({ kind: "leaf", node, parent });
    } else {
      const open: Token = { kind: "open", type: node.type };
      if (node.attrs) open.attrs = node.attrs;
      if (node.marks?.length) open.marks = node.marks;
      out.push(open);
      flatten(node.content ?? [], node.type, schema, out);
      out.push({ kind: "close" });
    }
  }
  return out;
};

const pushText = (into: Node[], text: string, marks?: Mark[]) => {
  const last = into[into.length - 1];
  if (last && last.type === "text" && sameMarks(last.marks, marks)) {
    into[into.length - 1] = { ...last, text: (last.text ?? "") + text };
  } else {
    into.push(marks?.length ? { type: "text", text, marks } : { type: "text", text });
  }
};

/** Rebuilds nodes from tokens; returns null when the tokens are not balanced. */
export const build = (tokens: readonly Token[]): Node[] | null => {
  const root: Node[] = [];
  const stack: { node: Node; content: Node[] }[] = [];
  let run = "";
  let runMarks: Mark[] | undefined;
  const current = () => (stack.length ? stack[stack.length - 1]!.content : root);
  const flush = () => {
    if (run) pushText(current(), run, runMarks);
    run = "";
    runMarks = undefined;
  };
  for (const token of tokens) {
    if (token.kind === "char") {
      if (run && !sameMarks(runMarks, token.marks)) flush();
      if (!run) runMarks = token.marks;
      run += token.ch;
      continue;
    }
    flush();
    if (token.kind === "leaf") {
      current().push(token.node);
    } else if (token.kind === "open") {
      const node: Node = { type: token.type };
      if (token.attrs) node.attrs = token.attrs;
      if (token.marks?.length) node.marks = token.marks;
      stack.push({ node, content: [] });
    } else {
      const top = stack.pop();
      if (!top) return null;
      top.node.content = top.content;
      current().push(top.node);
    }
  }
  flush();
  if (stack.length) return null;
  return root;
};

export const toItems = (tokens: readonly Token[]): SliceItem[] => {
  const items: SliceItem[] = [];
  for (const token of tokens) {
    if (token.kind === "char") {
      const last = items[items.length - 1];
      if (last && "t" in last && sameMarks(last.m, token.marks)) {
        items[items.length - 1] = { ...last, t: last.t + token.ch };
      } else {
        items.push(token.marks?.length ? { t: token.ch, m: token.marks } : { t: token.ch });
      }
    } else if (token.kind === "leaf") {
      items.push({ n: token.node });
    } else if (token.kind === "open") {
      const item: SliceItem = { o: token.type };
      if (token.attrs) item.a = token.attrs;
      if (token.marks?.length) item.m = token.marks;
      items.push(item);
    } else {
      items.push({ c: 1 });
    }
  }
  return items;
};

/** Expands slice items into tokens; `parent` is a placeholder resolved on build. */
export const fromItems = (items: readonly SliceItem[]): Token[] => {
  const tokens: Token[] = [];
  for (const item of items) {
    if ("t" in item) {
      for (const ch of item.t) {
        // Iterating a string yields code points; split surrogate pairs back
        // into code units so sizes stay in UTF-16 units.
        for (let i = 0; i < ch.length; i++) {
          tokens.push(withMarks({ kind: "char" as const, ch: ch[i]!, parent: "" }, item.m));
        }
      }
    } else if ("n" in item) {
      tokens.push({ kind: "leaf", node: item.n, parent: "" });
    } else if ("o" in item) {
      const token: Token = { kind: "open", type: item.o };
      if (item.a) token.attrs = item.a;
      if (item.m?.length) token.marks = item.m;
      tokens.push(token);
    } else {
      tokens.push({ kind: "close" });
    }
  }
  return tokens;
};

/** Slice items for a list of whole nodes. */
export const nodesToItems = (nodes: readonly Node[], schema: Schema): SliceItem[] =>
  toItems(flatten(nodes, "", schema));

export interface ResolvedPos {
  pos: number;
  /** Depth of the innermost node whose content contains `pos` (0 = doc). */
  depth: number;
  /** `nodes[d]` is the ancestor at depth d; `nodes[depth]` is the parent. */
  nodes: Node[];
  /** Position where `nodes[d]`'s content starts. */
  starts: number[];
  /** Index of the child of `nodes[d]` at or after the position. */
  indices: number[];
  /** Offset into the text node at `indices[depth]`, when `pos` falls inside one. */
  textOffset: number;
}

export const resolve = (doc: Node, pos: number, schema: Schema): ResolvedPos => {
  const total = contentSize(doc, schema);
  if (pos < 0 || pos > total) throw new RangeError(`Position ${pos} out of range 0..${total}`);
  const nodes: Node[] = [doc];
  const starts: number[] = [0];
  const indices: number[] = [];
  let node = doc;
  let start = 0;
  let textOffset = 0;
  for (;;) {
    const children = node.content ?? [];
    let offset = start;
    let index = 0;
    let descend: Node | null = null;
    for (; index < children.length; index++) {
      const child = children[index]!;
      const size = nodeSize(child, schema);
      const end = offset + size;
      if (pos < end) {
        if (child.type === "text") {
          textOffset = pos - offset;
          break;
        }
        if (pos > offset && !schema.isLeaf(child.type)) {
          descend = child;
          start = offset + 1;
        }
        break;
      }
      offset = end;
    }
    indices.push(index);
    if (!descend) break;
    node = descend;
    nodes.push(node);
    starts.push(start);
  }
  return { pos, depth: nodes.length - 1, nodes, starts, indices, textOffset };
};

/** The child offsets of a node's content, relative to its content start. */
export const childOffsets = (node: Node, schema: Schema): number[] => {
  const offsets: number[] = [];
  let offset = 0;
  for (const child of node.content ?? []) {
    offsets.push(offset);
    offset += nodeSize(child, schema);
  }
  offsets.push(offset);
  return offsets;
};

/** Finds the node that starts exactly at `pos`, with its parent and index. */
export const nodeAt = (doc: Node, pos: number, schema: Schema) => {
  const $pos = resolve(doc, pos, schema);
  if ($pos.textOffset) return null;
  const parent = $pos.nodes[$pos.depth]!;
  const index = $pos.indices[$pos.depth]!;
  const node = parent.content?.[index];
  if (!node) return null;
  return { node, parent, index, depth: $pos.depth };
};

/** Calls `fn` for every node with its absolute start position; return false to skip children. */
export const descendants = (
  node: Node,
  schema: Schema,
  fn: (node: Node, pos: number, parent: Node, index: number) => boolean | void,
  start = 0,
) => {
  let offset = start;
  const children = node.content ?? [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const deeper = fn(child, offset, node, i);
    if (deeper !== false && child.content) descendants(child, schema, fn, offset + 1);
    offset += nodeSize(child, schema);
  }
};

/** Text between two positions, with `blockSeparator` between textblocks. */
export const textBetween = (
  doc: Node,
  from: number,
  to: number,
  schema: Schema,
  blockSeparator = "\n",
): string => {
  let text = "";
  let first = true;
  descendants(doc, schema, (node, pos) => {
    const end = pos + nodeSize(node, schema);
    if (end <= from || pos >= to) return false;
    if (node.type === "text") {
      const s = Math.max(from, pos) - pos;
      const e = Math.min(to, end) - pos;
      text += (node.text ?? "").slice(s, e);
    } else if (node.type === "hardBreak") {
      text += "\n";
    } else if (schema.isTextblock(node.type)) {
      if (!first) text += blockSeparator;
      first = false;
    }
    return true;
  });
  return text;
};
