import { sameAttrs, sameMarks, type Mark, type Node } from "./model";
import type { Schema } from "./schema";
import {
  isEmpty,
  selFrom,
  selTo,
  Transaction,
  type EditorState,
  type Selection
} from "./state";
import { $ } from "./resolved";
import { contentSize } from "./tokens";
import { deleteRangeInto, textblockEndBefore, textblockStartAfter } from "./commands";
import { Desc } from "./desc";
import { nodeRenderers, renderMark } from "./render";

export interface ViewProps {
  state: EditorState;
  /** Receives every transaction; the owner applies it and calls `updateState`. */
  dispatch: (tr: Transaction) => void;
  /** Return true to stop the default handling. */
  handleKeyDown?: (event: KeyboardEvent) => boolean;
  handleBeforeInput?: (event: InputEvent) => void;
  handlePaste?: (event: ClipboardEvent) => boolean;
  handleDragStart?: (event: DragEvent) => void;
  handleDrop?: (event: DragEvent) => boolean;
  /** Called once composed (IME) text has been read back into the document. */
  onCompositionEnd?: () => void;
  /** Attributes to set on rendered nodes (the placeholder), keyed by node position. */
  nodeAttrs?: (state: EditorState) => Map<number, Record<string, string>>;
}

const FILLER = "data-filler";

const isFiller = (node: globalThis.Node) =>
  node instanceof HTMLElement && node.hasAttribute(FILLER);

/**
 * Renders an editor state into a contenteditable element and turns DOM
 * input back into transactions. Typing goes through `beforeinput`; IME
 * composition and other edits the browser makes on its own are read back
 * from the DOM once they settle.
 */
export class EditorView {
  readonly dom: HTMLElement;
  state: EditorState;
  readonly schema: Schema;
  private props: ViewProps;
  private root: Desc;
  private textDescs = new WeakMap<globalThis.Node, Desc>();
  private domDescs = new WeakMap<globalThis.Node, Desc>();
  private contentDescs = new WeakMap<globalThis.Node, Desc>();
  private observer: MutationObserver;
  composing = false;
  private composingDesc: Desc | null = null;
  private composedBlocks = new Set<Desc>();
  private composedRange: { from: number; to: number } | null = null;
  private compositionTimer: ReturnType<typeof setTimeout> | null = null;
  private nativeEditTimer: ReturnType<typeof setTimeout> | null = null;
  private selectionWriting = false;
  private appliedAttrs: { el: HTMLElement; names: string[] }[] = [];
  private selectedDesc: Desc | null = null;
  private listeners: [EventTarget, string, EventListener][] = [];
  focused = false;
  destroyed = false;

  constructor(mount: HTMLElement, props: ViewProps) {
    this.props = props;
    this.state = props.state;
    this.schema = props.state.schema;
    this.dom = mount;
    this.dom.setAttribute("contenteditable", "true");
    this.dom.setAttribute("translate", "no");
    this.root = new Desc(this.state.doc, this.dom, this.dom, null, null);
    this.contentDescs.set(this.dom, this.root);
    this.observer = new MutationObserver((records) => this.onMutations(records));
    this.renderChildren(this.root, this.state.doc);
    this.applyNodeAttrs();
    this.startObserving();
    this.bindEvents();
  }

  updateState(state: EditorState) {
    const prev = this.state;
    this.state = state;
    // Drawn once the browser's own edit has landed.
    if (this.nativeEditTimer !== null) return;
    if (prev.doc !== state.doc) {
      this.stopObserving();
      this.renderChildren(this.root, state.doc);
      this.startObserving();
    }
    this.applyNodeAttrs();
    this.syncNodeSelection(state.selection);
    if (this.focused && !this.composing) this.writeSelection();
  }

  focus() {
    this.dom.focus({ preventScroll: true });
    this.writeSelection();
  }

  destroy() {
    this.destroyed = true;
    if (this.compositionTimer !== null) clearTimeout(this.compositionTimer);
    this.compositionTimer = null;
    if (this.nativeEditTimer !== null) clearTimeout(this.nativeEditTimer);
    this.nativeEditTimer = null;
    this.observer.disconnect();
    for (const [target, type, fn] of this.listeners) target.removeEventListener(type, fn);
    this.listeners = [];
    this.dom.textContent = "";
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private register(desc: Desc) {
    this.domDescs.set(desc.dom, desc);
    if (desc.contentDOM) this.contentDescs.set(desc.contentDOM, desc);
    if (desc.textDOM) this.textDescs.set(desc.textDOM, desc);
    return desc;
  }

  private wrapInMarks(dom: globalThis.Node, marks: readonly Mark[]) {
    let outer = dom;
    for (let i = marks.length - 1; i >= 0; i--) {
      const spec = renderMark(marks[i]!);
      (spec.contentDOM ?? spec.dom).appendChild(outer);
      outer = spec.dom;
    }
    return outer;
  }

  private createDesc(node: Node, parent: Desc): Desc {
    if (node.type === "text") {
      const text = document.createTextNode(node.text ?? "");
      const outer = this.wrapInMarks(text, node.marks ?? []);
      return this.register(new Desc(node, outer, null, text, parent));
    }
    const renderer = nodeRenderers[node.type];
    const spec = renderer ? renderer(node) : { dom: document.createElement("div") };
    if (this.schema.isLeaf(node.type)) spec.dom.setAttribute("contenteditable", "false");
    const outer = this.wrapInMarks(spec.dom, node.marks ?? []);
    const desc = this.register(new Desc(node, outer, spec.contentDOM ?? null, null, parent));
    if (desc.contentDOM) this.renderChildren(desc, node);
    return desc;
  }

  private canUpdate(desc: Desc, node: Node): boolean {
    if (desc.node.type !== node.type || !sameMarks(desc.node.marks, node.marks)) return false;
    return node.type === "text" || sameAttrs(desc.node.attrs, node.attrs);
  }

  private updateDesc(desc: Desc, node: Node) {
    if (desc.node === node) return;
    if (desc.textDOM) {
      if (desc.textDOM.data !== node.text) desc.textDOM.data = node.text ?? "";
    } else if (desc.contentDOM) {
      this.renderChildren(desc, node);
    }
    desc.node = node;
  }

  private renderChildren(desc: Desc, node: Node) {
    const contentDOM = desc.contentDOM!;
    const old = desc.children;
    const used = new Set<Desc>();
    const next: Desc[] = [];
    let cursor = 0;
    for (const child of node.content ?? []) {
      let match: Desc | null = null;
      for (let k = cursor; k < Math.min(old.length, cursor + 8); k++) {
        if (old[k]!.node === child && !used.has(old[k]!)) {
          match = old[k]!;
          cursor = k + 1;
          break;
        }
      }
      if (!match && cursor < old.length && !used.has(old[cursor]!)) {
        const candidate = old[cursor]!;
        const composing =
          this.composing && this.composingDesc && isAncestor(candidate, this.composingDesc);
        if (composing || this.canUpdate(candidate, child)) {
          this.updateDesc(candidate, child);
          match = candidate;
          cursor++;
        }
      }
      if (match) {
        used.add(match);
        match.node = child;
        next.push(match);
      } else {
        next.push(this.createDesc(child, desc));
      }
    }
    desc.children = next;
    desc.node = node;

    const wanted: globalThis.Node[] = next.map((d) => d.dom);
    // An empty textblock, or one ending in a line break, needs a filler <br>
    // to have height and take the caret.
    const needsFiller =
      this.schema.isTextblock(node.type) &&
      (next.length === 0 || next[next.length - 1]!.node.type === "hardBreak");
    let filler = Array.from(contentDOM.childNodes).find(isFiller);
    if (needsFiller) {
      if (!filler) {
        filler = document.createElement("br");
        (filler as HTMLElement).setAttribute(FILLER, "");
      }
      wanted.push(filler);
    }
    let current = contentDOM.firstChild;
    for (const dom of wanted) {
      if (current === dom) current = current.nextSibling;
      else contentDOM.insertBefore(dom, current);
    }
    while (current) {
      const after = current.nextSibling;
      contentDOM.removeChild(current);
      current = after;
    }
  }

  private applyNodeAttrs() {
    for (const { el, names } of this.appliedAttrs) for (const n of names) el.removeAttribute(n);
    this.appliedAttrs = [];
    const attrs = this.props.nodeAttrs?.(this.state);
    if (!attrs) return;
    for (const [pos, values] of attrs) {
      const desc = this.descAt(pos);
      const el = desc && (desc.contentDOM ?? desc.dom);
      if (!(el instanceof HTMLElement)) continue;
      for (const [k, v] of Object.entries(values)) el.setAttribute(k, v);
      this.appliedAttrs.push({ el, names: Object.keys(values) });
    }
  }

  private syncNodeSelection(sel: Selection) {
    const desc = sel.node ? this.descAt(sel.anchor) : null;
    if (desc === this.selectedDesc) return;
    (this.selectedDesc?.dom as HTMLElement | undefined)?.classList?.remove("node-selected");
    this.selectedDesc = desc;
    (desc?.dom as HTMLElement | undefined)?.classList?.add("node-selected");
  }

  // -------------------------------------------------------------------------
  // Positions
  // -------------------------------------------------------------------------

  /** Position just before the node of `desc`. */
  posOf(desc: Desc): number {
    if (!desc.parent) return -1;
    let pos = this.contentStart(desc.parent);
    for (const sibling of desc.parent.children) {
      if (sibling === desc) return pos;
      pos += sibling.size(this.schema);
    }
    return pos;
  }

  private contentStart(desc: Desc): number {
    return desc.parent ? this.posOf(desc) + 1 : 0;
  }

  /** The descriptor of the node starting at `pos`. */
  descAt(pos: number): Desc | null {
    let desc = this.root;
    let start = 0;
    for (;;) {
      let offset = start;
      let next: Desc | null = null;
      for (const child of desc.children) {
        const size = child.size(this.schema);
        if (offset === pos) return child;
        if (pos > offset && pos < offset + size && child.children.length) {
          next = child;
          start = offset + 1;
          break;
        }
        offset += size;
      }
      if (!next) return null;
      desc = next;
    }
  }

  posFromDOM(dom: globalThis.Node, offset: number): number | null {
    if (dom.nodeType === 3 && !this.textDescs.has(dom)) {
      // Text the browser inserted itself (IME, spellcheck) is not tracked yet;
      // measure it against the surrounding content.
      const block = this.nearestContentDesc(dom);
      if (block) {
        return this.contentStart(block) + this.measureWithin(block.contentDOM!, dom, offset);
      }
    }
    let node: globalThis.Node | null = dom;
    let off = offset;
    while (node) {
      const text = this.textDescs.get(node);
      if (text) return this.posOf(text) + Math.min(off, text.textDOM!.length);
      const content = this.contentDescs.get(node);
      if (content) {
        let pos = this.contentStart(content);
        const kids = node.childNodes;
        for (let i = 0; i < off && i < kids.length; i++) {
          const kid = kids[i]!;
          const d = this.domDescs.get(kid);
          if (d && d.parent === content) pos += d.size(this.schema);
          else if (!isFiller(kid)) pos += this.untrackedLength(kid);
        }
        return pos;
      }
      const owner = this.domDescs.get(node);
      if (owner) {
        const size = owner.size(this.schema);
        if (owner.contentDOM && !owner.textDOM) {
          // A point inside a wrapper whose content lives deeper: before or after.
          const contentIndex = indexWithin(node, owner.contentDOM);
          return this.posOf(owner) + (off <= contentIndex ? 1 : size - 1);
        }
        return this.posOf(owner) + (off > 0 ? size : 0);
      }
      const parent: globalThis.Node | null = node.parentNode;
      if (!parent || node === this.dom) return null;
      const index = Array.prototype.indexOf.call(parent.childNodes, node);
      const isEnd = node.nodeType === 3 ? off > 0 : off > 0 && off >= node.childNodes.length;
      off = index + (isEnd ? 1 : 0);
      node = parent;
    }
    return null;
  }

  private nearestContentDesc(node: globalThis.Node): Desc | null {
    let n: globalThis.Node | null = node.parentNode;
    while (n && n !== this.dom.parentNode) {
      const d = this.contentDescs.get(n);
      if (d) return d;
      n = n.parentNode;
    }
    return null;
  }

  private untrackedLength(node: globalThis.Node): number {
    if (node.nodeType === 3) return (node as Text).length;
    if (node instanceof HTMLBRElement) return 0;
    let total = 0;
    for (const child of Array.from(node.childNodes)) {
      const d = this.textDescs.get(child) ?? this.domDescs.get(child);
      total += d ? d.size(this.schema) : this.untrackedLength(child);
    }
    return total;
  }

  /** Offset of (target, offset) from the start of `container`'s content. */
  private measureWithin(
    container: globalThis.Node,
    target: globalThis.Node,
    offset: number
  ): number {
    let acc = 0;
    for (const child of Array.from(container.childNodes)) {
      if (child === target) return acc + offset;
      if (child.contains(target)) {
        const d = this.domDescs.get(child);
        if (d?.textDOM && d.textDOM === target) return acc + offset;
        return acc + this.measureWithin(child, target, offset);
      }
      if (isFiller(child)) continue;
      const d = this.textDescs.get(child) ?? this.domDescs.get(child);
      acc += d ? d.size(this.schema) : this.untrackedLength(child);
    }
    return acc;
  }

  domFromPos(pos: number): { node: globalThis.Node; offset: number } {
    let desc = this.root;
    let start = 0;
    for (;;) {
      let offset = start;
      let index = 0;
      let inside: Desc | null = null;
      for (; index < desc.children.length; index++) {
        const child = desc.children[index]!;
        const end = offset + child.size(this.schema);
        if (child.isText && pos >= offset && pos <= end && (pos < end || pos > offset)) {
          return { node: child.textDOM!, offset: pos - offset };
        }
        if (pos < end) {
          if (pos > offset && child.contentDOM) {
            inside = child;
            start = offset + 1;
          }
          break;
        }
        offset = end;
      }
      if (inside) {
        desc = inside;
        continue;
      }
      const contentDOM = desc.contentDOM!;
      const before = desc.children[index - 1];
      if (before?.isText) return { node: before.textDOM!, offset: before.textDOM!.length };
      const after = desc.children[index];
      if (after?.isText) return { node: after.textDOM!, offset: 0 };
      const domIndex = after ? indexWithin(after.dom, contentDOM) : fillerIndex(contentDOM);
      return { node: contentDOM, offset: domIndex };
    }
  }

  /** Screen rectangle of a position. */
  coordsAtPos(pos: number): DOMRect | null {
    const { node, offset } = this.domFromPos(pos);
    const range = document.createRange();
    try {
      range.setStart(node, offset);
      range.setEnd(node, offset);
    } catch {
      return null;
    }
    const rects = range.getClientRects();
    if (rects.length) return rects[rects.length - 1]!;
    const target = node.nodeType === 1 ? (node as Element) : node.parentElement;
    if (!target) return null;
    const child = node.nodeType === 1 ? (node as Element).childNodes[offset] : null;
    const el = child instanceof Element ? child : target;
    const r = el.getBoundingClientRect();
    return new DOMRect(r.left, r.top, 0, r.height || 18);
  }

  /** Document position under a screen point, or null outside the editor. */
  posAtCoords(x: number, y: number): number | null {
    type CaretPosition = { offsetNode: globalThis.Node; offset: number };
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => CaretPosition | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const point = doc.caretPositionFromPoint
      ? doc.caretPositionFromPoint(x, y)
      : (() => {
          const range = doc.caretRangeFromPoint?.(x, y);
          return range ? { offsetNode: range.startContainer, offset: range.startOffset } : null;
        })();
    if (!point || !this.dom.contains(point.offsetNode)) return null;
    return this.posFromDOM(point.offsetNode, point.offset);
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  readSelection(): Selection | null {
    const sel = document.getSelection();
    if (!sel || !sel.anchorNode || !sel.focusNode) return null;
    if (!this.dom.contains(sel.anchorNode) || !this.dom.contains(sel.focusNode)) return null;
    const anchor = this.posFromDOM(sel.anchorNode, sel.anchorOffset);
    const head = this.posFromDOM(sel.focusNode, sel.focusOffset);
    if (anchor === null || head === null) return null;
    return { anchor, head };
  }

  writeSelection() {
    if (this.destroyed) return;
    const sel = this.state.selection;
    const domSel = document.getSelection();
    if (!domSel) return;
    this.selectionWriting = true;
    try {
      if (sel.node) {
        const desc = this.descAt(sel.anchor);
        if (desc?.dom.parentNode) {
          const range = document.createRange();
          range.selectNode(desc.dom);
          domSel.removeAllRanges();
          domSel.addRange(range);
        }
        return;
      }
      const current = this.readSelection();
      if (current && current.anchor === sel.anchor && current.head === sel.head) return;
      const anchor = this.domFromPos(sel.anchor);
      const head = this.domFromPos(sel.head);
      domSel.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
    } catch {
      // A position can briefly point at DOM that is mid-update; ignore.
    } finally {
      this.selectionWriting = false;
    }
  }

  private onSelectionChange = () => {
    if (this.selectionWriting || this.composing || !this.focused) return;
    if (this.nativeEditTimer !== null) return;
    const sel = this.readSelection();
    if (!sel) return;
    const current = this.state.selection;
    if (current.node && sel.anchor === current.anchor) return;
    if (sel.anchor === current.anchor && sel.head === current.head && !current.node) return;
    if (this.keepsWholeDocSelection(sel)) return;
    const tr = new Transaction(this.state);
    tr.setSelection(sel);
    this.props.dispatch(tr);
  };

  /**
   * The browser shows a whole-document selection as one from the first
   * textblock's start to the last one's end; reading that back keeps the
   * whole-document selection.
   */
  private keepsWholeDocSelection(sel: Selection) {
    const { doc, selection } = this.state;
    const size = contentSize(doc, this.schema);
    if (selFrom(selection) !== 0 || selTo(selection) !== size) return false;
    const first = textblockStartAfter(doc, 0, this.schema) ?? 0;
    const last = textblockEndBefore(doc, size, this.schema) ?? size;
    return selFrom(sel) <= first && selTo(sel) >= last;
  }

  // -------------------------------------------------------------------------
  // DOM observation (fallback for edits the browser made on its own)
  // -------------------------------------------------------------------------

  private startObserving() {
    this.observer.observe(this.dom, {
      childList: true,
      characterData: true,
      subtree: true,
      characterDataOldValue: true
    });
  }

  private stopObserving() {
    const records = this.observer.takeRecords();
    if (records.length) this.onMutations(records);
    this.observer.disconnect();
  }

  /**
   * For an input the browser applies itself because it cannot be cancelled.
   * The caller applies the same edit to the model; the DOM is redrawn from
   * the model once the browser's edit lands, instead of being read back.
   */
  expectNativeEdit() {
    this.flushNativeEdit();
    this.nativeEditTimer = setTimeout(() => this.flushNativeEdit(), 0);
  }

  private flushNativeEdit() {
    if (this.nativeEditTimer !== null) this.syncAfterNativeEdit(this.observer.takeRecords());
  }

  private syncAfterNativeEdit(records: MutationRecord[]) {
    clearTimeout(this.nativeEditTimer!);
    this.nativeEditTimer = null;
    const blocks = new Set<Desc>();
    const containers = new Set<Desc>();
    for (const record of [...records, ...this.observer.takeRecords()]) {
      const desc = this.nearestDesc(record.target);
      const block = this.textblockOf(desc);
      if (block) blocks.add(block);
      else if (desc?.contentDOM) containers.add(desc);
      for (const n of record.removedNodes) {
        const removed = this.domDescs.get(n);
        if (removed && this.schema.isTextblock(removed.node.type)) blocks.add(removed);
      }
    }
    this.observer.disconnect();
    this.renderChildren(this.root, this.state.doc);
    for (const c of containers) if (this.inTree(c)) this.renderChildren(c, c.node);
    for (const b of blocks) {
      if (!this.inTree(b) || this.inSync(b)) continue;
      b.children = [];
      b.contentDOM!.textContent = "";
      this.renderChildren(b, b.node);
    }
    this.startObserving();
    this.applyNodeAttrs();
    this.syncNodeSelection(this.state.selection);
    if (this.focused && !this.composing) this.writeSelection();
  }

  private inTree(desc: Desc) {
    let d = desc;
    for (; d.parent; d = d.parent) if (!d.parent.children.includes(d)) return false;
    return d === this.root;
  }

  /** Whether a textblock's DOM is exactly what rendering its node produces. */
  private inSync(block: Desc) {
    const nodes = Array.from(block.contentDOM!.childNodes);
    const kids = nodes.filter((n) => !isFiller(n));
    const last = block.children[block.children.length - 1];
    const needsFiller = !last || last.node.type === "hardBreak";
    if (kids.length !== block.children.length || needsFiller !== kids.length < nodes.length) {
      return false;
    }
    return block.children.every((d, i) => {
      if (kids[i] !== d.dom) return false;
      if (!d.textDOM) return d.dom.textContent === "";
      for (let n: globalThis.Node = d.dom; n !== d.textDOM; n = n.firstChild!) {
        if (n.childNodes.length !== 1) return false;
      }
      return d.textDOM.data === d.node.text;
    });
  }

  private onMutations(records: MutationRecord[]) {
    if (this.nativeEditTimer !== null && !this.composing) {
      this.syncAfterNativeEdit(records);
      return;
    }
    if (this.composing) {
      // Read back once the composition ends.
      for (const record of records) {
        const block = this.textblockOf(this.nearestDesc(record.target));
        if (block) this.composedBlocks.add(block);
      }
      return;
    }
    const blocks = new Set<Desc>();
    const containers = new Set<Desc>();
    for (const record of records) {
      const desc = this.nearestDesc(record.target);
      if (record.type === "childList") {
        const changed = [...record.addedNodes, ...record.removedNodes];
        if (changed.every(isFiller)) continue;
        // WebKit can delete a whole block element (select all + delete on an
        // empty doc); the model still has it, so put it back.
        for (const n of record.removedNodes) {
          const removed = this.domDescs.get(n);
          if (removed?.parent && !this.schema.isTextblock(removed.parent.node.type)) {
            containers.add(removed.parent);
          }
        }
        // Blocks the browser added on its own are not in the model; take them out.
        const container = this.contentDescs.get(record.target);
        if (container && !this.schema.isTextblock(container.node.type)) {
          const untracked = [...record.addedNodes].some((n) => !this.domDescs.has(n));
          if (untracked) containers.add(container);
        }
      }
      const block = this.textblockOf(desc);
      if (block) blocks.add(block);
    }
    if (containers.size) {
      this.stopObserving();
      for (const c of containers) this.renderChildren(c, c.node);
      this.startObserving();
      if (this.focused) this.writeSelection();
    }
    if (blocks.size) this.reconcileBlocks([...blocks]);
  }

  private nearestDesc(node: globalThis.Node | null): Desc | null {
    while (node) {
      const d = this.textDescs.get(node) ?? this.domDescs.get(node) ?? this.contentDescs.get(node);
      if (d) return d;
      node = node.parentNode;
    }
    return null;
  }

  private textblockOf(desc: Desc | null): Desc | null {
    while (desc) {
      if (desc.parent && this.schema.isTextblock(desc.node.type)) return desc;
      desc = desc.parent;
    }
    return null;
  }

  /**
   * Reads the inline content of textblocks back from the DOM and turns any
   * difference into a replace step. Used after IME composition and for
   * browser-made edits like spellcheck corrections.
   */
  private reconcileBlocks(blocks: Desc[]) {
    const tr = new Transaction(this.state);
    const sorted = blocks
      .filter((b) => b.parent && b.contentDOM && this.dom.contains(b.contentDOM))
      .map((b) => ({ b, pos: this.posOf(b) }))
      .sort((x, y) => y.pos - x.pos);
    for (const { b, pos } of sorted) {
      const diff = diffInline(b.node.content ?? [], this.readInline(b));
      if (!diff) continue;
      const start = pos + 1;
      tr.maybeStep({
        stepType: "replace",
        from: start + diff.from,
        to: start + diff.toOld,
        slice: diff.slice
      });
    }
    const sel = this.readSelection();
    if (!tr.docChanged) {
      // Put the DOM back in sync with the unchanged model.
      this.stopObserving();
      for (const { b } of sorted) {
        const node = b.node;
        b.children = [];
        b.contentDOM!.textContent = "";
        this.renderChildren(b, node);
      }
      this.startObserving();
      return;
    }
    if (sel) tr.setSelection(sel);
    tr.setMeta("domChange", true);
    this.props.dispatch(tr);
  }

  /**
   * After a composition over a selection: deletes the selection in the model,
   * as the browser did in the DOM (merging blocks when it spanned several),
   * then reads the composed text back from the block it landed in.
   */
  private reconcileReplacedRange(range: { from: number; to: number }, inline: Node[] | null) {
    const tr = new Transaction(this.state);
    const at = deleteRangeInto(tr, range.from, range.to);
    const $at = $(tr.doc, at, this.schema);
    let caret = at;
    if (inline) {
      const diff = diffInline($at.parent.content ?? [], inline);
      if (diff && tr.maybeStep({
        stepType: "replace",
        from: $at.start() + diff.from,
        to: $at.start() + diff.toOld,
        slice: diff.slice
      })) {
        caret = $at.start() + diff.from + Transaction.sliceSize(diff.slice);
      }
    }
    tr.setSelection({ anchor: caret, head: caret });
    tr.setMeta("domChange", true);
    this.props.dispatch(tr);
  }

  private readInline(block: Desc): Node[] {
    return this.readInlineFrom([block.contentDOM!], block);
  }

  /** Inline content of DOM nodes; descriptors count only when they belong to `block`. */
  private readInlineFrom(nodes: globalThis.Node[], block: Desc | null): Node[] {
    const result: Node[] = [];
    let lastMarks: Mark[] | undefined;
    const walk = (parent: globalThis.Node) => {
      for (const child of Array.from(parent.childNodes)) {
        const textDesc = this.textDescs.get(child);
        if (textDesc) {
          lastMarks = textDesc.node.marks;
          const text = (child as Text).data;
          if (text) result.push({ ...textDesc.node, text });
          continue;
        }
        const desc = this.domDescs.get(child);
        if (desc && desc.parent === block) {
          if (desc.isText) {
            lastMarks = desc.node.marks;
            const text = desc.dom.textContent ?? "";
            if (text) result.push({ ...desc.node, text });
          } else {
            result.push(desc.node);
          }
          continue;
        }
        if (child.nodeType === 3) {
          const text = (child as Text).data;
          if (!text) continue;
          result.push(
            lastMarks?.length ? { type: "text", text, marks: lastMarks } : { type: "text", text }
          );
        } else if (!isFiller(child) && !(child instanceof HTMLBRElement)) {
          walk(child);
        }
      }
    };
    for (const node of nodes) {
      if (node.nodeType === 3) {
        const text = (node as Text).data;
        if (text) result.push({ type: "text", text });
      } else {
        walk(node);
      }
    }
    return mergeTexts(result);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private on(target: EventTarget, type: string, fn: (e: Event) => void) {
    target.addEventListener(type, fn);
    this.listeners.push([target, type, fn]);
  }

  private bindEvents() {
    this.on(document, "selectionchange", this.onSelectionChange);
    this.on(this.dom, "focus", () => {
      this.focused = true;
    });
    this.on(this.dom, "blur", () => {
      this.focused = false;
    });
    this.on(this.dom, "beforeinput", (e) => {
      // selectionchange fires asynchronously; make sure the model has the
      // caret the user just placed before acting on input.
      this.flushNativeEdit();
      if (!this.composing) this.onSelectionChange();
      this.props.handleBeforeInput?.(e as InputEvent);
    });
    this.on(this.dom, "keydown", (e) => {
      const event = e as KeyboardEvent;
      if (event.isComposing || event.keyCode === 229) return;
      this.flushNativeEdit();
      this.onSelectionChange();
      if (this.props.handleKeyDown?.(event)) event.preventDefault();
    });
    this.on(this.dom, "compositionstart", () => {
      // A new composition can start before the previous one's deferred
      // reconcile ran (IMEs commit a syllable and start the next at once).
      if (this.compositionTimer !== null) {
        clearTimeout(this.compositionTimer);
        this.finishComposition();
      }
      this.flushNativeEdit();
      this.onSelectionChange();
      this.composing = true;
      const { selection } = this.state;
      const replaces = !isEmpty(selection) && !selection.node;
      // Composing over a selection replaces it, possibly merging blocks.
      this.composedRange = replaces ? { from: selFrom(selection), to: selTo(selection) } : null;
      const sel = replaces ? null : this.readSelection();
      const caret = replaces ? selFrom(selection) : sel?.head;
      this.composingDesc = caret === undefined ? null : this.textblockOf(this.descAround(caret));
      if (replaces && !this.composingDesc) {
        // The selection starts outside any textblock (it covers the whole
        // document); the browser composes into the first one it covers.
        const first = textblockStartAfter(this.state.doc, caret!, this.schema);
        if (first !== null) this.composingDesc = this.textblockOf(this.descAround(first));
      }
    });
    this.on(this.dom, "compositionend", () => {
      // Some browsers fire compositionend before the final input event; let
      // that land before reading the DOM.
      this.compositionTimer = setTimeout(() => this.finishComposition(), 0);
    });
    this.on(this.dom, "paste", (e) => {
      if (this.props.handlePaste?.(e as ClipboardEvent)) e.preventDefault();
    });
    this.on(this.dom, "dragstart", (e) => this.props.handleDragStart?.(e as DragEvent));
    this.on(this.dom, "drop", (e) => {
      if (this.props.handleDrop?.(e as DragEvent)) e.preventDefault();
    });
    this.on(this.dom, "mousedown", (e) => {
      const desc = this.nearestDesc(e.target as globalThis.Node);
      // Clicking a leaf block (a rule) selects it as a node.
      if (desc && !desc.isText && !desc.contentDOM && desc.parent) {
        const pos = this.posOf(desc);
        const tr = new Transaction(this.state);
        tr.setSelection({ anchor: pos, head: pos + desc.size(this.schema), node: true });
        this.props.dispatch(tr);
        if (!this.focused) this.dom.focus({ preventScroll: true });
        e.preventDefault();
      }
    });
  }

  private finishComposition() {
    this.compositionTimer = null;
    const range = this.composedRange;
    this.composedRange = null;
    if (range) {
      const block = this.composingDesc;
      const fallback = block?.contentDOM && this.dom.contains(block.contentDOM);
      const inline = this.composedInline() ?? (fallback ? this.readInline(block!) : null);
      this.composing = false;
      this.composingDesc = null;
      this.composedBlocks = new Set();
      this.observer.takeRecords();
      this.reconcileReplacedRange(range, inline);
      this.props.onCompositionEnd?.();
      return;
    }
    const blocks = this.composedBlocks;
    for (const record of this.observer.takeRecords()) {
      const block = this.textblockOf(this.nearestDesc(record.target));
      if (block) blocks.add(block);
    }
    if (this.composingDesc) blocks.add(this.composingDesc);
    this.composing = false;
    this.composingDesc = null;
    this.composedBlocks = new Set();
    if (blocks.size) this.reconcileBlocks([...blocks]);
    this.props.onCompositionEnd?.();
  }

  /**
   * Inline content of the block the DOM caret is in once a composition over
   * a selection ends. Over a whole document the browser can leave the text
   * in an element of its own, or directly in the editor.
   */
  private composedInline(): Node[] | null {
    const focus = document.getSelection()?.focusNode;
    if (!focus || focus === this.dom || !this.dom.contains(focus)) return null;
    const block = this.textblockOf(this.nearestDesc(focus));
    if (block?.contentDOM?.contains(focus)) return this.readInline(block);
    let top: globalThis.Node = focus;
    for (;;) {
      if (isBlockElement(top)) return this.readInlineFrom([top], null);
      if (top.parentNode === this.dom) break;
      top = top.parentNode!;
    }
    const run = [top];
    for (let n = top.previousSibling; n && !isBlockElement(n); n = n.previousSibling) run.unshift(n);
    for (let n = top.nextSibling; n && !isBlockElement(n); n = n.nextSibling) run.push(n);
    return this.readInlineFrom(run, null);
  }

  /** Descriptor of the text or node around a position. */
  private descAround(pos: number): Desc | null {
    return this.nearestDesc(this.domFromPos(pos).node);
  }
}

const BLOCK_ELEMENTS = new Set([
  "P", "DIV", "PRE", "BLOCKQUOTE", "UL", "OL", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "HR"
]);

const isBlockElement = (node: globalThis.Node) => BLOCK_ELEMENTS.has(node.nodeName);

const isAncestor = (ancestor: Desc, desc: Desc) => {
  for (let d: Desc | null = desc; d; d = d.parent) if (d === ancestor) return true;
  return false;
};

const indexWithin = (dom: globalThis.Node, parent: globalThis.Node): number => {
  let node: globalThis.Node | null = dom;
  while (node && node.parentNode !== parent) node = node.parentNode;
  return node ? Array.prototype.indexOf.call(parent.childNodes, node) : parent.childNodes.length;
};

const fillerIndex = (contentDOM: HTMLElement): number => {
  const index = Array.from(contentDOM.childNodes).findIndex(isFiller);
  return index < 0 ? contentDOM.childNodes.length : index;
};

const mergeTexts = (nodes: Node[]): Node[] => {
  const out: Node[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (last?.type === "text" && node.type === "text" && sameMarks(last.marks, node.marks)) {
      out[out.length - 1] = { ...last, text: (last.text ?? "") + (node.text ?? "") };
    } else {
      out.push(node);
    }
  }
  return out;
};

/** Smallest replace that turns `before` into `after` (inline content of one textblock). */
const diffInline = (before: Node[], after: Node[]) => {
  const units = (nodes: Node[]) => {
    const out: { key: string; node: Node }[] = [];
    for (const node of nodes) {
      if (node.type !== "text") {
        out.push({ key: JSON.stringify(node), node });
        continue;
      }
      const marks = JSON.stringify(node.marks ?? []);
      const text = node.text ?? "";
      for (let i = 0; i < text.length; i++) {
        out.push({ key: text[i]! + marks, node: { ...node, text: text[i]! } });
      }
    }
    return out;
  };
  const a = units(before);
  const b = units(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start]!.key === b[start]!.key) start++;
  if (start === a.length && start === b.length) return null;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1]!.key === b[endB - 1]!.key) {
    endA--;
    endB--;
  }
  const slice = mergeTexts(b.slice(start, endB).map((u) => u.node)).map((n) =>
    n.type === "text" ? (n.marks?.length ? { t: n.text!, m: n.marks } : { t: n.text! }) : { n }
  );
  return { from: start, toOld: endA, slice };
};
