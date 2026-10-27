import type { Node } from "./model";
import type { Schema } from "./schema";
import { nodeSize } from "./tokens";

/**
 * A view descriptor mirrors one document node and the DOM rendered for it.
 * The tree of descriptors is how the view converts between DOM points and
 * document positions, and how it reuses DOM across updates.
 */
export class Desc {
  children: Desc[] = [];

  constructor(
    public node: Node,
    readonly dom: globalThis.Node,
    readonly contentDOM: HTMLElement | null,
    readonly textDOM: Text | null,
    readonly parent: Desc | null
  ) {}

  get isText() {
    return this.textDOM !== null;
  }

  size(schema: Schema) {
    return nodeSize(this.node, schema);
  }
}

export interface RenderSpec {
  dom: HTMLElement;
  contentDOM?: HTMLElement;
}

export type NodeRenderer = (node: Node) => RenderSpec;
