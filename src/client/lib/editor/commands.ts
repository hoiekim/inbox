import { sameMark, type Attrs, type Mark, type Node } from "./model";
import { $, blockRange } from "./resolved";
import type { Schema } from "./schema";
import { Transaction, isEmpty, selFrom, selTo, type EditorState } from "./state";
import { StepError } from "./steps";
import { contentSize, descendants, nodeAt, nodeSize, nodesToItems, type SliceItem } from "./tokens";

export type Dispatch = (tr: Transaction) => void;
export type Command = (state: EditorState, dispatch?: Dispatch) => boolean;

const run = (
  state: EditorState,
  dispatch: Dispatch | undefined,
  build: (tr: Transaction) => boolean | void
) => {
  const tr = new Transaction(state);
  try {
    if (build(tr) === false) return false;
  } catch (e) {
    if (e instanceof StepError || e instanceof RangeError) return false;
    throw e;
  }
  if (!tr.docChanged && !tr.selectionSet && !tr.storedMarksSet) return false;
  dispatch?.(tr.scroll());
  return true;
};

const cursor = (tr: Transaction, pos: number) => tr.setSelection({ anchor: pos, head: pos });

/** First position inside a textblock at or after `pos` (searching forward), or null. */
export const textblockStartAfter = (doc: Node, pos: number, schema: Schema): number | null => {
  let found: number | null = null;
  descendants(doc, schema, (node, p) => {
    if (found !== null) return false;
    if (p + nodeSize(node, schema) <= pos) return false;
    if (schema.isTextblock(node.type) && p >= pos - 1) {
      found = p + 1;
      return false;
    }
    return true;
  });
  return found;
};

/** Last position inside a textblock at or before `pos`, or null. */
export const textblockEndBefore = (doc: Node, pos: number, schema: Schema): number | null => {
  let found: number | null = null;
  descendants(doc, schema, (node, p) => {
    if (p >= pos) return false;
    if (schema.isTextblock(node.type)) {
      const end = p + nodeSize(node, schema) - 1;
      if (end <= pos) found = end;
      return false;
    }
    return true;
  });
  return found;
};

/** Marks that text typed at the cursor would get. */
export const marksAt = (state: EditorState): Mark[] => {
  if (state.storedMarks) return state.storedMarks;
  const { schema, doc, selection } = state;
  const $pos = $(doc, selFrom(selection), schema);
  const before = $pos.nodeBefore;
  const after = $pos.nodeAfter;
  const source =
    before && before.type === "text" ? before : after && after.type === "text" ? after : null;
  const marks = source?.marks ?? [];
  return marks.filter((m) => {
    if (schema.marks[m.type]?.inclusive !== false) return true;
    return !!(after?.marks?.some((x) => sameMark(x, m)) && before?.type === "text");
  });
};

/** Marks to carry onto the next line after a split, like a word processor. */
const marksToKeep = (state: EditorState): Mark[] | null => {
  if (state.storedMarks) return state.storedMarks;
  const $from = $(state.doc, selFrom(state.selection), state.schema);
  if (!$from.parentOffset) return null;
  const marks = marksAt(state);
  return marks.length ? marks : null;
};

/** Whether the selection spans the whole document, as select-all makes it. */
export const coversDoc = (state: EditorState) =>
  selFrom(state.selection) === 0 &&
  selTo(state.selection) === contentSize(state.doc, state.schema);

export const insertText =
  (text: string, from?: number, to?: number): Command =>
  (state, dispatch) =>
    run(state, dispatch, (tr) => {
      const a = from ?? selFrom(state.selection);
      const b = to ?? selTo(state.selection);
      const marks = marksAt(state);
      const at = a !== b ? deleteRangeInto(tr, a, b) : a;
      const parent = $(tr.doc, at, state.schema).parent;
      if (!state.schema.isTextblock(parent.type)) return false;
      const allowed = state.schema.isCode(parent.type)
        ? []
        : marks.filter((m) => state.schema.allowsMark(parent.type, m.type));
      tr.insertText(text, at, at, allowed);
      cursor(tr, at + text.length);
    });

/**
 * Deletes [from, to) and returns where the caret goes. When the range crosses
 * blocks, the content of the last touched textblock joins the first one; when
 * it is the whole document, one empty paragraph is left.
 */
export const deleteRangeInto = (tr: Transaction, from: number, to: number): number => {
  const schema = tr.schema;
  if (from === 0 && to === contentSize(tr.doc, schema)) {
    tr.replace(0, to, [{ o: "paragraph" }, { c: 1 }]);
    return 1;
  }
  deleteRangeBetweenBlocks(tr, from, to);
  return tr.mapping.map(from, -1);
};

const deleteRangeBetweenBlocks = (tr: Transaction, from: number, to: number) => {
  const schema = tr.schema;
  const $from = $(tr.doc, from, schema);
  const $to = $(tr.doc, to, schema);
  if ($from.parent === $to.parent || from === to) {
    tr.delete(from, to);
    return;
  }
  if (tr.maybeStep({ stepType: "replace", from, to, slice: [] })) return;
  const fromBlockDepth = $from.findDepth((n) => schema.isTextblock(n.type));
  const toBlockDepth = $to.findDepth((n) => schema.isTextblock(n.type));
  if (fromBlockDepth < 0 || toBlockDepth < 0) {
    tr.maybeStep({ stepType: "replace", from, to, slice: [] });
    return;
  }
  const tail = ($to.parent.content ?? []).length
    ? sliceInline($to.parent, $to.parentOffset, contentSize($to.parent, schema), schema)
    : [];
  const shared = $from.sharedDepth($to);
  const endOfToBranch = $to.after(shared + 1);
  const fromBlockEnd = $from.end(fromBlockDepth);
  tr.delete(from, fromBlockEnd);
  const mappedEnd = tr.mapping.map(endOfToBranch);
  const mappedFromBlockEnd = tr.mapping.map(fromBlockEnd);
  const afterFromBranch = $(tr.doc, mappedFromBlockEnd, schema).after(shared + 1);
  if (mappedEnd > afterFromBranch) tr.delete(afterFromBranch, mappedEnd);
  if (tail.length) tr.replace(tr.mapping.map(from, -1), tr.mapping.map(from, -1), tail);
};

/** Inline content of a textblock between two offsets, as slice items. */
const sliceInline = (block: Node, start: number, end: number, schema: Schema): SliceItem[] => {
  const items: SliceItem[] = [];
  let offset = 0;
  for (const child of block.content ?? []) {
    const size = nodeSize(child, schema);
    const s = Math.max(start, offset);
    const e = Math.min(end, offset + size);
    if (e > s) {
      if (child.type === "text") {
        const t = child.text!.slice(s - offset, e - offset);
        items.push(child.marks?.length ? { t, m: child.marks } : { t });
      } else {
        items.push({ n: child });
      }
    }
    offset += size;
  }
  return items;
};

export const deleteSelection: Command = (state, dispatch) => {
  if (isEmpty(state.selection)) return false;
  return run(state, dispatch, (tr) => {
    const from = selFrom(state.selection);
    const to = selTo(state.selection);
    if (state.selection.node) {
      tr.delete(from, to);
      const $pos = $(tr.doc, Math.min(from, contentSize(tr.doc, tr.schema)), tr.schema);
      if (!tr.schema.isTextblock($pos.parent.type)) {
        // Deleting the only block leaves the parent empty; refill it with a paragraph.
        if (!tr.schema.validContent($pos.parent.type, $pos.parent.content ?? [])) {
          tr.replace(from, from, nodesToItems([tr.schema.node("paragraph")], tr.schema));
          cursor(tr, from + 1);
          return;
        }
        const next = textblockStartAfter(tr.doc, from, tr.schema);
        cursor(tr, next ?? textblockEndBefore(tr.doc, from, tr.schema) ?? from);
        return;
      }
      cursor(tr, from);
      return;
    }
    cursor(tr, deleteRangeInto(tr, from, to));
  });
};

interface GraphemeSegmenter {
  segment(text: string): Iterable<{ segment: string }>;
}

type SegmenterConstructor = new (
  locale: undefined,
  options: { granularity: "grapheme" }
) => GraphemeSegmenter;

const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
const segmenter = Segmenter ? new Segmenter(undefined, { granularity: "grapheme" }) : null;

const graphemeBefore = (text: string): number => {
  if (!segmenter) return 1;
  const segments = [...segmenter.segment(text)];
  return segments[segments.length - 1]?.segment.length ?? 1;
};

const graphemeAfter = (text: string): number => {
  if (!segmenter) return 1;
  for (const { segment } of segmenter.segment(text)) return segment.length;
  return 1;
};

export const deleteBackward: Command = (state, dispatch) => {
  if (!isEmpty(state.selection) || state.selection.node) return deleteSelection(state, dispatch);
  const { schema, doc } = state;
  const pos = state.selection.head;
  const $pos = $(doc, pos, schema);
  if (!schema.isTextblock($pos.parent.type)) return false;
  if (!$pos.atStart) {
    const before = $pos.nodeBefore;
    const size = before?.type === "text" ? graphemeBefore(before.text!) : 1;
    return run(state, dispatch, (tr) => {
      tr.delete(pos - size, pos);
      cursor(tr, pos - size);
    });
  }
  return joinBackward(state, dispatch);
};

export const deleteForward: Command = (state, dispatch) => {
  if (!isEmpty(state.selection) || state.selection.node) return deleteSelection(state, dispatch);
  const { schema, doc } = state;
  const pos = state.selection.head;
  const $pos = $(doc, pos, schema);
  if (!schema.isTextblock($pos.parent.type)) return false;
  if (!$pos.atEnd) {
    const after = $pos.nodeAfter;
    const size = after?.type === "text" ? graphemeAfter(after.text!) : 1;
    return run(state, dispatch, (tr) => {
      tr.delete(pos, pos + size);
    });
  }
  return joinForward(state, dispatch);
};

/** Backspace at the start of a textblock. */
export const joinBackward: Command = (state, dispatch) => {
  const { schema, doc } = state;
  const pos = state.selection.head;
  const $pos = $(doc, pos, schema);
  // In a list item, the first backspace lifts the item out of the list.
  const itemDepth = $pos.findDepth((n) => n.type === "listItem");
  if (itemDepth > 0 && $pos.index(itemDepth) === 0 && $pos.depth === itemDepth + 1) {
    if (liftListItem(state, dispatch)) return true;
  }
  const prevEnd = textblockEndBefore(doc, $pos.before(), schema);
  // An empty heading or code block at the top, or any code block start,
  // turns back into a paragraph.
  const parentType = $pos.parent.type;
  const blockEmpty = contentSize($pos.parent, schema) === 0;
  const clears = schema.isCode(parentType)
    ? blockEmpty || prevEnd === null
    : blockEmpty && prevEnd === null;
  if (parentType !== "paragraph" && clears) {
    if (setBlockTypeAt(state, dispatch, $pos.before(), "paragraph")) return true;
  }
  // The first block of a quote: lift it out.
  const wrapperDepth = $pos.depth - 1;
  if (wrapperDepth > 0 && $pos.index(wrapperDepth) === 0) {
    if ($pos.node(wrapperDepth).type === "blockquote") return lift(state, dispatch);
  }
  const prevSibling = $pos.node($pos.depth - 1).content?.[$pos.index($pos.depth - 1) - 1];
  // A leaf block right before (a rule): an empty block goes away and the rule
  // is selected; otherwise the rule is deleted.
  if (prevSibling && schema.isLeaf(prevSibling.type)) {
    const start = $pos.before() - 1;
    return run(state, dispatch, (tr) => {
      if (contentSize($pos.parent, schema) === 0) {
        tr.delete($pos.before(), $pos.after());
        tr.setSelection({ anchor: start, head: start + 1, node: true });
      } else {
        tr.delete(start, start + 1);
        cursor(tr, pos - 1);
      }
    });
  }
  if (prevEnd === null) return false;
  return run(state, dispatch, (tr) => {
    if (tr.maybeStep({ stepType: "replace", from: prevEnd, to: pos, slice: [] })) {
      cursor(tr, prevEnd);
      return;
    }
    // Structures differ (e.g. a paragraph after a list): move this block's text
    // to the end of the previous textblock and delete this block.
    const text = sliceInline($pos.parent, 0, contentSize($pos.parent, schema), schema);
    const blockFrom = $pos.before();
    tr.delete(blockFrom, $pos.after());
    removeEmptyAncestors(tr, blockFrom);
    if (text.length) tr.replace(prevEnd, prevEnd, text);
    cursor(tr, prevEnd);
  });
};

/** Delete at the end of a textblock. */
export const joinForward: Command = (state, dispatch) => {
  const { schema, doc } = state;
  const pos = state.selection.head;
  const $pos = $(doc, pos, schema);
  const nextStart = textblockStartAfter(doc, $pos.after(), schema);
  const nextSibling = $pos.node($pos.depth - 1).content?.[$pos.index($pos.depth - 1) + 1];
  if (nextSibling && schema.isLeaf(nextSibling.type)) {
    const start = $pos.after();
    return run(state, dispatch, (tr) => {
      tr.delete(start, start + 1);
    });
  }
  if (nextStart === null) return false;
  const $next = $(doc, nextStart, schema);
  return run(state, dispatch, (tr) => {
    if (tr.maybeStep({ stepType: "replace", from: pos, to: nextStart, slice: [] })) return;
    const text = sliceInline($next.parent, 0, contentSize($next.parent, schema), schema);
    const blockFrom = $next.before();
    tr.delete(blockFrom, $next.after());
    removeEmptyAncestors(tr, blockFrom);
    if (text.length) tr.replace(pos, pos, text);
    cursor(tr, pos);
  });
};

/** After deleting a block, removes wrappers left without valid content. */
const removeEmptyAncestors = (tr: Transaction, pos: number) => {
  const schema = tr.schema;
  for (let i = 0; i < 6; i++) {
    const $pos = $(tr.doc, Math.min(pos, contentSize(tr.doc, schema)), schema);
    const parent = $pos.parent;
    if ($pos.depth === 0 || schema.validContent(parent.type, parent.content ?? [])) return;
    tr.maybeStep({ stepType: "replace", from: $pos.before(), to: $pos.after(), slice: [] });
    pos = tr.mapping.map(pos);
  }
};

export const isList = (type: string) => type === "bulletList" || type === "orderedList";

/** Enter. */
export const splitBlock: Command = (state, dispatch) => {
  const { schema } = state;
  // Enter over the whole document clears it, leaving no line before the caret.
  if (coversDoc(state)) return deleteSelection(state, dispatch);
  const from = selFrom(state.selection);
  const $from = $(state.doc, from, schema);
  const parent = $from.parent;
  if (!schema.isTextblock(parent.type)) {
    if (state.selection.node) {
      const after = selTo(state.selection);
      return run(state, dispatch, (tr) => {
        tr.replace(after, after, nodesToItems([schema.node("paragraph")], schema));
        cursor(tr, after + 1);
      });
    }
    return false;
  }
  if (schema.isCode(parent.type)) return insertText("\n")(state, dispatch);
  const empty = contentSize(parent, schema) === 0 && isEmpty(state.selection);
  const itemDepth = $from.depth - 1;
  const inItem = itemDepth > 0 && $from.node(itemDepth).type === "listItem";
  // Empty list item: leave the list (or move up one nesting level).
  if (inItem && empty && ($from.node(itemDepth).content ?? []).length === 1) {
    return liftListItem(state, dispatch);
  }
  if (inItem) return splitListItem(state, dispatch);
  // Empty paragraph in a quote: step out of the quote.
  if (empty && itemDepth > 0 && $from.node(itemDepth).type === "blockquote") {
    if (lift(state, dispatch)) return true;
  }
  const keep = marksToKeep(state);
  return run(state, dispatch, (tr) => {
    const at = isEmpty(state.selection) ? from : deleteRangeInto(tr, from, selTo(state.selection));
    const atEnd = $(tr.doc, at, schema).atEnd;
    const keepType = !atEnd || parent.type === "paragraph";
    const nextType = keepType ? parent.type : "paragraph";
    const attrs = keepType ? parent.attrs : schema.attrs("paragraph");
    const open: SliceItem = attrs ? { o: nextType, a: attrs } : { o: nextType };
    tr.replace(at, at, [{ c: 1 }, open]);
    cursor(tr, at + 2);
    if (keep) tr.setStoredMarks(keep);
  });
};

export const splitListItem: Command = (state, dispatch) => {
  const { schema } = state;
  const from = selFrom(state.selection);
  const $from = $(state.doc, from, schema);
  const itemDepth = $from.findDepth((n) => n.type === "listItem");
  if (itemDepth < 0) return false;
  const keep = marksToKeep(state);
  return run(state, dispatch, (tr) => {
    const at = isEmpty(state.selection) ? from : deleteRangeInto(tr, from, selTo(state.selection));
    tr.replace(at, at, [{ c: 1 }, { c: 1 }, { o: "listItem" }, { o: "paragraph" }]);
    cursor(tr, at + 4);
    if (keep) tr.setStoredMarks(keep);
  });
};

export const insertHardBreak: Command = (state, dispatch) => {
  const { schema } = state;
  const $from = $(state.doc, selFrom(state.selection), schema);
  const all = coversDoc(state);
  if (!all && (!schema.isTextblock($from.parent.type) || schema.isCode($from.parent.type))) {
    return false;
  }
  const keep = all ? null : marksToKeep(state);
  return run(state, dispatch, (tr) => {
    const from = selFrom(state.selection);
    const at = isEmpty(state.selection) ? from : deleteRangeInto(tr, from, selTo(state.selection));
    tr.replace(at, at, [{ n: { type: "hardBreak" } }]);
    cursor(tr, at + 1);
    if (keep) tr.setStoredMarks(keep);
  });
};

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

/** Ranges of inline content within the selection, per textblock. */
const inlineRanges = (state: EditorState) => {
  const { doc, schema, selection } = state;
  const from = selFrom(selection);
  const to = selTo(selection);
  const ranges: { from: number; to: number; parent: string }[] = [];
  descendants(doc, schema, (node, pos) => {
    const end = pos + nodeSize(node, schema);
    if (end < from || pos > to) return false;
    if (schema.isTextblock(node.type)) {
      const s = Math.max(from, pos + 1);
      const e = Math.min(to, end - 1);
      if (e > s) ranges.push({ from: s, to: e, parent: node.type });
      return false;
    }
    return true;
  });
  return ranges;
};

/** Whether every character in the selection carries the mark type. */
export const markActive = (state: EditorState, type: string): boolean => {
  if (isEmpty(state.selection)) return marksAt(state).some((m) => m.type === type);
  let all = true;
  let any = false;
  const { doc, schema } = state;
  for (const range of inlineRanges(state)) {
    descendants(doc, schema, (node, pos) => {
      const end = pos + nodeSize(node, schema);
      if (end <= range.from || pos >= range.to) return false;
      if (node.type === "text") {
        any = true;
        if (!node.marks?.some((m) => m.type === type)) all = false;
      }
      return true;
    });
  }
  return any && all;
};

export const setMark =
  (mark: Mark): Command =>
  (state, dispatch) => {
    const { schema } = state;
    if (isEmpty(state.selection)) {
      const current = marksAt(state);
      if (current.some((m) => m.type !== mark.type && schema.excludes(m.type, mark.type))) {
        return false;
      }
      return run(state, dispatch, (tr) => {
        tr.setStoredMarks([...current.filter((m) => !schema.excludes(mark.type, m.type)), mark]);
      });
    }
    return run(state, dispatch, (tr) => {
      for (const range of inlineRanges(state)) tr.addMark(range.from, range.to, mark);
      if (!tr.docChanged) return false;
    });
  };

export const unsetMark =
  (type: string): Command =>
  (state, dispatch) => {
    if (isEmpty(state.selection)) {
      return run(state, dispatch, (tr) => {
        tr.setStoredMarks(marksAt(state).filter((m) => m.type !== type));
      });
    }
    return run(state, dispatch, (tr) => {
      for (const range of inlineRanges(state)) tr.removeMark(range.from, range.to, type);
      if (!tr.docChanged) return false;
    });
  };

export const toggleMark =
  (type: string): Command =>
  (state, dispatch) =>
    markActive(state, type)
      ? unsetMark(type)(state, dispatch)
      : setMark(state.schema.mark(type))(state, dispatch);

// ---------------------------------------------------------------------------
// Block types and wrapping
// ---------------------------------------------------------------------------

const retype = (tr: Transaction, blockPos: number, type: string, attrs?: Attrs) => {
  const found = nodeAt(tr.doc, blockPos, tr.schema);
  if (!found) return;
  const size = nodeSize(found.node, tr.schema);
  const merged = tr.schema.attrs(type, attrs);
  const open: SliceItem = merged ? { o: type, a: merged } : { o: type };
  if (tr.schema.isCode(type)) {
    // Code blocks hold plain text: drop marks and turn hard breaks into newlines.
    const text = (found.node.content ?? [])
      .map((c) => (c.type === "text" ? c.text : c.type === "hardBreak" ? "\n" : ""))
      .join("");
    tr.replace(blockPos, blockPos + size, [open, ...(text ? [{ t: text }] : []), { c: 1 }]);
    return;
  }
  tr.step({
    stepType: "replaceAround",
    from: blockPos,
    to: blockPos + size,
    gapFrom: blockPos + 1,
    gapTo: blockPos + size - 1,
    slice: [open, { c: 1 }],
    insert: 1
  });
};

const canRetype = (tr: Transaction, blockPos: number, type: string) => {
  const $p = $(tr.doc, blockPos + 1, tr.schema);
  const container = $p.node($p.depth - 1);
  const index = $p.index($p.depth - 1);
  const replaced = (container.content ?? []).map((c, i) => (i === index ? { ...c, type } : c));
  return tr.schema.validContent(container.type, replaced);
};

const setBlockTypeAt = (
  state: EditorState,
  dispatch: Dispatch | undefined,
  blockPos: number,
  type: string,
  attrs?: Attrs
) =>
  run(state, dispatch, (tr) => {
    if (!canRetype(tr, blockPos, type)) return false;
    retype(tr, blockPos, type, attrs);
  });

const sameAttrsLoose = (a?: Attrs, b?: Attrs) => {
  if (!b) return true;
  return Object.entries(b).every(([k, v]) => a?.[k] === v);
};

/** Changes every textblock in the selection to `type`. */
export const setBlockType =
  (type: string, attrs?: Attrs): Command =>
  (state, dispatch) => {
    const { doc, schema, selection } = state;
    const from = selFrom(selection);
    const to = selTo(selection);
    const targets: number[] = [];
    descendants(doc, schema, (node, pos) => {
      const end = pos + nodeSize(node, schema);
      if (end < from || pos > to) return false;
      if (schema.isTextblock(node.type)) {
        if (node.type !== type || !sameAttrsLoose(node.attrs, attrs)) targets.push(pos);
        return false;
      }
      return true;
    });
    if (!targets.length) return false;
    return run(state, dispatch, (tr) => {
      for (const pos of targets) {
        const mapped = tr.mapping.map(pos);
        if (!nodeAt(tr.doc, mapped, tr.schema) || !canRetype(tr, mapped, type)) continue;
        retype(tr, mapped, type, attrs);
      }
      if (!tr.docChanged) return false;
      // Retyping keeps every block's size, so positions stay where they were.
      tr.setSelection(selection);
    });
  };

export const blockTypeActive = (state: EditorState, type: string, attrs?: Attrs) => {
  const node = $(state.doc, selFrom(state.selection), state.schema).parent;
  return node.type === type && sameAttrsLoose(node.attrs, attrs);
};

/** Sets `type`, or back to a paragraph when the block already is one. */
export const toggleBlockType =
  (type: string, attrs?: Attrs): Command =>
  (state, dispatch) =>
    blockTypeActive(state, type, attrs)
      ? setBlockType("paragraph")(state, dispatch)
      : setBlockType(type, attrs)(state, dispatch);

/** Wraps the selected blocks in `type` (a quote or, with `innerType`, a list). */
export const wrapIn =
  (type: string, attrs?: Attrs, innerType?: string): Command =>
  (state, dispatch) => {
    const { doc, schema, selection } = state;
    const range = blockRange($(doc, selFrom(selection), schema), $(doc, selTo(selection), schema));
    if (!range) return false;
    return run(state, dispatch, (tr) => {
      const merged = schema.attrs(type, attrs);
      if (innerType) {
        const blocks = (range.parent.content ?? []).slice(range.startIndex, range.endIndex);
        const items: Node[] = blocks.map((b) => ({
          type: innerType,
          content: [
            schema.isTextblock(b.type) && b.type !== "paragraph"
              ? { ...b, type: "paragraph", attrs: undefined }
              : b
          ]
        }));
        const list: Node = { type, ...(merged ? { attrs: merged } : {}), content: items };
        tr.replace(range.from, range.to, nodesToItems([list], schema));
        // Each wrapped block gains a list open and an item open before it,
        // plus an item close/open pair per earlier block.
        const shift = (pos: number) => {
          let offset = range.from;
          for (let k = 0; k < blocks.length; k++) {
            const end = offset + nodeSize(blocks[k]!, schema);
            if (pos <= end) return pos + 2 + 2 * k;
            offset = end;
          }
          return pos + 2 * blocks.length;
        };
        tr.setSelection({ anchor: shift(selection.anchor), head: shift(selection.head) });
        return;
      }
      const outer: SliceItem = merged ? { o: type, a: merged } : { o: type };
      tr.step({
        stepType: "replaceAround",
        from: range.from,
        to: range.to,
        gapFrom: range.from,
        gapTo: range.to,
        slice: [outer, { c: 1 }],
        insert: 1
      });
      tr.setSelection({
        anchor: tr.mapping.map(selection.anchor),
        head: tr.mapping.map(selection.head)
      });
    });
  };

/** Moves the selected blocks out of their wrapper (a quote or a list). */
export const lift: Command = (state, dispatch) => {
  const { doc, schema, selection } = state;
  const $from = $(doc, selFrom(selection), schema);
  const $to = $(doc, selTo(selection), schema);
  const range = blockRange($from, $to, (_n, d) => d > 0);
  if (!range) return false;
  const $wrap = $(doc, range.from, schema);
  const wrapperDepth = range.depth;
  const wrapper = range.parent;
  const grand = $wrap.node(wrapperDepth - 1);
  const children = wrapper.content ?? [];
  const lifted = children.slice(range.startIndex, range.endIndex);
  const before = children.slice(0, range.startIndex);
  const after = children.slice(range.endIndex);
  const replacement = [...(grand.content ?? [])];
  replacement.splice(
    $wrap.index(wrapperDepth - 1),
    1,
    ...(before.length ? [{ ...wrapper, content: before }] : []),
    ...lifted,
    ...(after.length ? [{ ...wrapper, content: after }] : [])
  );
  if (!schema.validContent(grand.type, replacement)) return false;
  return run(state, dispatch, (tr) => {
    const slice: SliceItem[] = [];
    const open: SliceItem = wrapper.attrs
      ? { o: wrapper.type, a: wrapper.attrs }
      : { o: wrapper.type };
    // Close the wrapper before the lifted blocks and reopen it after, keeping
    // the lifted blocks themselves as the gap.
    if (before.length) slice.push({ c: 1 });
    const insert = Transaction.sliceSize(slice);
    if (after.length) slice.push(open);
    tr.step({
      stepType: "replaceAround",
      from: before.length ? range.from : $wrap.before(wrapperDepth),
      to: after.length ? range.to : $wrap.after(wrapperDepth),
      gapFrom: range.from,
      gapTo: range.to,
      slice,
      insert
    });
    tr.setSelection({
      anchor: tr.mapping.map(selection.anchor),
      head: tr.mapping.map(selection.head)
    });
  });
};

export const toggleWrap =
  (type: string): Command =>
  (state, dispatch) => {
    const $from = $(state.doc, selFrom(state.selection), state.schema);
    if ($from.findDepth((n) => n.type === type) > 0) return lift(state, dispatch);
    return wrapIn(type)(state, dispatch);
  };

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export const toggleList =
  (listType: string): Command =>
  (state, dispatch) => {
    const { schema } = state;
    const $from = $(state.doc, selFrom(state.selection), schema);
    const listDepth = $from.findDepth((n) => isList(n.type));
    if (listDepth > 0) {
      const list = $from.node(listDepth);
      if (list.type === listType) return liftListItem(state, dispatch);
      // Switch the list kind in place; positions stay the same.
      return run(state, dispatch, (tr) => {
        const pos = $from.before(listDepth);
        const merged = schema.attrs(listType);
        const next: Node = { ...list, type: listType, attrs: merged };
        if (!merged) delete next.attrs;
        tr.replace(pos, pos + nodeSize(list, schema), nodesToItems([next], schema));
        tr.setSelection(state.selection);
      });
    }
    return wrapIn(listType, undefined, "listItem")(state, dispatch);
  };

/** Moves the current list item out one level (or out of the list). */
export const liftListItem: Command = (state, dispatch) => {
  const { schema, doc } = state;
  const $from = $(doc, selFrom(state.selection), schema);
  const itemDepth = $from.findDepth((n) => n.type === "listItem");
  if (itemDepth < 1) return false;
  const listDepth = itemDepth - 1;
  const list = $from.node(listDepth);
  const item = $from.node(itemDepth);
  const itemIndex = $from.index(listDepth);
  const listPos = $from.before(listDepth);
  const outer = $from.node(listDepth - 1);
  const nestedInItem = listDepth - 1 > 0 && outer.type === "listItem";
  const items = list.content ?? [];
  const before = items.slice(0, itemIndex);
  const after = items.slice(itemIndex + 1);
  return run(state, dispatch, (tr) => {
    const listNode = (content: Node[]): Node => ({ ...list, content });
    const offsetInItem = selFrom(state.selection) - $from.start(itemDepth);
    if (nestedInItem) {
      // A sub-list item becomes a sibling of its parent item, taking the
      // following items as its own sub-list.
      const parentItemDepth = listDepth - 1;
      const parentItem = $from.node(parentItemDepth);
      const parentItemPos = $from.before(parentItemDepth);
      const parentContent = parentItem.content ?? [];
      const listIndexInParent = $from.index(parentItemDepth);
      const newParent: Node = {
        ...parentItem,
        content: [
          ...parentContent.slice(0, listIndexInParent),
          ...(before.length ? [listNode(before)] : []),
          ...parentContent.slice(listIndexInParent + 1)
        ]
      };
      const movedItem: Node = {
        ...item,
        content: [...(item.content ?? []), ...(after.length ? [listNode(after)] : [])]
      };
      const size = nodeSize(parentItem, schema);
      const moved = nodesToItems([newParent, movedItem], schema);
      tr.replace(parentItemPos, parentItemPos + size, moved);
      const movedStart = parentItemPos + nodeSize(newParent, schema) + 1;
      cursor(tr, movedStart + offsetInItem);
      return;
    }
    // Top level: the item's blocks leave the list.
    const blocks = item.content ?? [];
    const replacement: Node[] = [
      ...(before.length ? [listNode(before)] : []),
      ...blocks,
      ...(after.length ? [listNode(after)] : [])
    ];
    const outerContent = outer.content ?? [];
    const index = $from.index(listDepth - 1);
    const next = [
      ...outerContent.slice(0, index),
      ...replacement,
      ...outerContent.slice(index + 1)
    ];
    if (!schema.validContent(outer.type, next)) return false;
    tr.replace(listPos, listPos + nodeSize(list, schema), nodesToItems(replacement, schema));
    const blocksStart = listPos + (before.length ? nodeSize(listNode(before), schema) : 0);
    cursor(tr, blocksStart + offsetInItem);
  });
};

/** Tab in a list: nests the item under its previous sibling. */
export const sinkListItem: Command = (state, dispatch) => {
  const { schema, doc } = state;
  const $from = $(doc, selFrom(state.selection), schema);
  const itemDepth = $from.findDepth((n) => n.type === "listItem");
  if (itemDepth < 1) return false;
  const listDepth = itemDepth - 1;
  const itemIndex = $from.index(listDepth);
  if (itemIndex === 0) return false;
  const list = $from.node(listDepth);
  const items = list.content ?? [];
  const prev = items[itemIndex - 1]!;
  const item = items[itemIndex]!;
  const prevContent = prev.content ?? [];
  const lastOfPrev = prevContent[prevContent.length - 1];
  return run(state, dispatch, (tr) => {
    const prevPos = $from.posAtIndex(itemIndex - 1, listDepth);
    const offsetInItem = selFrom(state.selection) - $from.start(itemDepth);
    let newPrev: Node;
    if (lastOfPrev && lastOfPrev.type === list.type) {
      const nested = { ...lastOfPrev, content: [...(lastOfPrev.content ?? []), item] };
      newPrev = { ...prev, content: [...prevContent.slice(0, -1), nested] };
    } else {
      const attrs = list.type === "orderedList" ? { ...list.attrs, start: 1 } : list.attrs;
      newPrev = { ...prev, content: [...prevContent, { ...list, attrs, content: [item] }] };
    }
    const end = prevPos + nodeSize(prev, schema) + nodeSize(item, schema);
    tr.replace(prevPos, end, nodesToItems([newPrev], schema));
    const itemAfter = prevPos + nodeSize(newPrev, schema) - 2;
    const itemBefore = itemAfter - nodeSize(item, schema);
    cursor(tr, itemBefore + 1 + offsetInItem);
  });
};

/** Selects the whole document, so typing or deleting replaces everything. */
export const selectAll: Command = (state, dispatch) =>
  run(state, dispatch, (tr) => {
    tr.setSelection({ anchor: 0, head: contentSize(state.doc, state.schema) });
  });

/** Leaves a code block, with a paragraph after it. */
export const exitCode: Command = (state, dispatch) => {
  const { schema } = state;
  const $from = $(state.doc, selFrom(state.selection), schema);
  if (!schema.isCode($from.parent.type)) return false;
  return run(state, dispatch, (tr) => {
    const after = $from.after();
    tr.replace(after, after, nodesToItems([schema.node("paragraph")], schema));
    cursor(tr, after + 1);
  });
};

export const chain =
  (...commands: Command[]): Command =>
  (state, dispatch) => {
    for (const command of commands) if (command(state, dispatch)) return true;
    return false;
  };
