import type { Node } from "./model";
import type { Schema } from "./schema";
import { contentSize, nodeSize, resolve, type ResolvedPos } from "./tokens";

/** Convenience accessors over a resolved position. */
export class Pos {
  readonly r: ResolvedPos;
  constructor(
    readonly doc: Node,
    readonly pos: number,
    readonly schema: Schema,
  ) {
    this.r = resolve(doc, pos, schema);
  }

  get depth() {
    return this.r.depth;
  }

  node(depth = this.depth): Node {
    return this.r.nodes[depth]!;
  }

  get parent(): Node {
    return this.node(this.depth);
  }

  /** Index of the child at or after the position in the node at `depth`. */
  index(depth = this.depth) {
    return this.r.indices[depth]!;
  }

  /** Start of the content of the node at `depth`. */
  start(depth = this.depth) {
    return this.r.starts[depth]!;
  }

  end(depth = this.depth) {
    return this.start(depth) + contentSize(this.node(depth), this.schema);
  }

  /** Position before the node at `depth` (depth >= 1). */
  before(depth = this.depth) {
    return this.start(depth) - 1;
  }

  after(depth = this.depth) {
    return this.end(depth) + 1;
  }

  /** Offset into the parent's content. */
  get parentOffset() {
    return this.pos - this.start();
  }

  get atStart() {
    return this.pos === this.start();
  }

  get atEnd() {
    return this.pos === this.end();
  }

  /** The node directly after the position (whole text node if inside one). */
  get nodeAfter(): Node | null {
    const children = this.parent.content ?? [];
    const child = children[this.index()];
    if (!child) return null;
    if (this.r.textOffset && child.type === "text") {
      return { ...child, text: child.text!.slice(this.r.textOffset) };
    }
    return child;
  }

  get nodeBefore(): Node | null {
    const children = this.parent.content ?? [];
    if (this.r.textOffset) {
      const child = children[this.index()]!;
      return { ...child, text: child.text!.slice(0, this.r.textOffset) };
    }
    return children[this.index() - 1] ?? null;
  }

  /** Depth of the innermost ancestor matching `pred`, or -1. */
  findDepth(pred: (node: Node, depth: number) => boolean) {
    for (let d = this.depth; d >= 0; d--) if (pred(this.node(d), d)) return d;
    return -1;
  }

  /** Shared ancestor depth with another resolved position. */
  sharedDepth(other: Pos) {
    let d = Math.min(this.depth, other.depth);
    while (d > 0 && this.node(d) !== other.node(d)) d--;
    return d;
  }

  /** Position of the start of child `index` within the node at `depth`. */
  posAtIndex(index: number, depth = this.depth) {
    let pos = this.start(depth);
    const children = this.node(depth).content ?? [];
    for (let i = 0; i < index && i < children.length; i++) {
      pos += nodeSize(children[i]!, this.schema);
    }
    return pos;
  }
}

export const $ = (doc: Node, pos: number, schema: Schema) => new Pos(doc, pos, schema);

/** Range of sibling blocks covering two positions. */
export interface BlockRange {
  depth: number;
  parent: Node;
  startIndex: number;
  endIndex: number;
  /** Position before the first block and after the last. */
  from: number;
  to: number;
}

export const blockRange = (
  $from: Pos,
  $to: Pos,
  pred?: (parent: Node, depth: number) => boolean,
): BlockRange | null => {
  const schema = $from.schema;
  for (let d = Math.min($from.depth, $to.depth); d >= 0; d--) {
    if ($from.node(d) !== $to.node(d)) continue;
    const parent = $from.node(d);
    if (schema.isTextblock(parent.type)) continue;
    if (pred && !pred(parent, d)) continue;
    const startIndex = $from.index(d);
    const endIndex = Math.max($to.index(d) + (d < $to.depth ? 1 : 0), startIndex + 1);
    return {
      depth: d,
      parent,
      startIndex,
      endIndex,
      from: $from.posAtIndex(startIndex, d),
      to: $from.posAtIndex(endIndex, d),
    };
  }
  return null;
};
