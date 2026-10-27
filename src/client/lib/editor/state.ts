import { hasMark, sameMark, type Mark, type Node } from "./model";
import type { Schema } from "./schema";
import { applyStep, Mapping, StepError, type Step } from "./steps";
import { contentSize, descendants, nodeAt, nodeSize, sliceSize, type SliceItem } from "./tokens";

/**
 * A text selection spans `anchor`..`head`. A node selection (`node: true`)
 * selects the single node starting at `anchor`, ending at `head`.
 */
export interface Selection {
  anchor: number;
  head: number;
  node?: boolean;
}

export const selFrom = (sel: Selection) => Math.min(sel.anchor, sel.head);
export const selTo = (sel: Selection) => Math.max(sel.anchor, sel.head);
export const isEmpty = (sel: Selection) => sel.anchor === sel.head;

export const mapSelection = (sel: Selection, mapping: Mapping): Selection => {
  if (sel.node) {
    const anchor = mapping.map(sel.anchor, 1);
    const head = mapping.map(sel.head, -1);
    if (head > anchor) return { anchor, head, node: true };
    return { anchor, head: anchor };
  }
  return { anchor: mapping.map(sel.anchor, 1), head: mapping.map(sel.head, 1) };
};

export interface EditorState {
  schema: Schema;
  doc: Node;
  selection: Selection;
  /** Marks applied to the next typed text, when set explicitly. */
  storedMarks: Mark[] | null;
}

export const createState = (schema: Schema, doc: Node, selection?: Selection): EditorState => ({
  schema,
  doc,
  selection: selection ?? { anchor: 1, head: 1 },
  storedMarks: null
});

interface InlineSpan {
  from: number;
  to: number;
  node: Node;
  parent: Node;
}

export class Transaction {
  readonly schema: Schema;
  readonly before: Node;
  doc: Node;
  readonly steps: Step[] = [];
  readonly inverses: Step[] = [];
  readonly mapping = new Mapping();
  selection: Selection;
  selectionSet = false;
  storedMarks: Mark[] | null;
  storedMarksSet = false;
  readonly meta = new Map<string, unknown>();
  scrollIntoView = false;

  constructor(state: EditorState) {
    this.schema = state.schema;
    this.before = state.doc;
    this.doc = state.doc;
    this.selection = state.selection;
    this.storedMarks = state.storedMarks;
  }

  get docChanged() {
    return this.steps.length > 0;
  }

  /** Applies a step; throws StepError when it does not fit. */
  step(step: Step) {
    const result = applyStep(this.doc, step, this.schema);
    this.steps.push(step);
    this.inverses.push(result.inverse);
    this.mapping.append(result.map);
    this.doc = result.doc;
    return this;
  }

  /** Applies a step if it fits; returns whether it did. */
  maybeStep(step: Step) {
    try {
      this.step(step);
      return true;
    } catch (e) {
      if (e instanceof StepError || e instanceof RangeError) return false;
      throw e;
    }
  }

  replace(from: number, to: number, slice: SliceItem[] = []) {
    if (from === to && !slice.length) return this;
    return this.step({ stepType: "replace", from, to, slice });
  }

  delete(from: number, to: number) {
    return this.replace(from, to, []);
  }

  insertText(text: string, from: number, to = from, marks?: Mark[] | null) {
    const slice: SliceItem[] = text ? [marks?.length ? { t: text, m: marks } : { t: text }] : [];
    return this.replace(from, to, slice);
  }

  private inlineSpans(from: number, to: number): InlineSpan[] {
    const spans: InlineSpan[] = [];
    descendants(this.doc, this.schema, (node, pos, parent) => {
      const end = pos + nodeSize(node, this.schema);
      if (end <= from || pos >= to) return false;
      if (this.schema.isInline(node.type)) {
        spans.push({ from: Math.max(from, pos), to: Math.min(to, end), node, parent });
        return false;
      }
      return true;
    });
    return spans;
  }

  /**
   * Adds `mark` to the inline content in [from, to). Steps cover only the
   * parts that lack it, and marks it excludes are removed by their own steps,
   * so undo restores exactly the previous marks.
   */
  addMark(from: number, to: number, mark: Mark) {
    const { schema } = this;
    const removals: { from: number; to: number; mark: Mark }[] = [];
    const additions: { from: number; to: number }[] = [];
    for (const span of this.inlineSpans(from, to)) {
      const marks = span.node.marks ?? [];
      if (!schema.allowsMark(span.parent.type, mark.type) || hasMark(marks, mark)) continue;
      if (marks.some((m) => m.type !== mark.type && schema.excludes(m.type, mark.type))) continue;
      for (const m of marks) {
        if (schema.excludes(mark.type, m.type)) removals.push({ ...span, mark: m });
      }
      const last = additions[additions.length - 1];
      if (last && last.to === span.from) last.to = span.to;
      else additions.push({ from: span.from, to: span.to });
    }
    for (const r of removals) this.step({ stepType: "removeMark", ...r });
    for (const a of additions) this.step({ stepType: "addMark", ...a, mark });
    return this;
  }

  /** Removes marks of `type` (or exactly `mark`) from the inline content in [from, to). */
  removeMark(from: number, to: number, mark: Mark | string) {
    const matches = (m: Mark) => (typeof mark === "string" ? m.type === mark : sameMark(m, mark));
    const removals: { from: number; to: number; mark: Mark }[] = [];
    for (const span of this.inlineSpans(from, to)) {
      for (const m of span.node.marks ?? []) {
        if (!matches(m)) continue;
        const last = removals.find((r) => r.to === span.from && sameMark(r.mark, m));
        if (last) last.to = span.to;
        else removals.push({ from: span.from, to: span.to, mark: m });
      }
    }
    for (const r of removals) this.step({ stepType: "removeMark", ...r });
    return this;
  }

  setSelection(selection: Selection) {
    const size = contentSize(this.doc, this.schema);
    const clamp = (n: number) => Math.max(0, Math.min(size, n));
    this.selection = { ...selection, anchor: clamp(selection.anchor), head: clamp(selection.head) };
    this.selectionSet = true;
    this.storedMarks = null;
    return this;
  }

  setStoredMarks(marks: Mark[] | null) {
    this.storedMarks = marks;
    this.storedMarksSet = true;
    return this;
  }

  setMeta(key: string, value: unknown) {
    this.meta.set(key, value);
    return this;
  }

  getMeta<T>(key: string): T | undefined {
    return this.meta.get(key) as T | undefined;
  }

  scroll() {
    this.scrollIntoView = true;
    return this;
  }

  /** Size of a slice, convenient for computing cursor targets. */
  static sliceSize = sliceSize;
}

export const applyTransaction = (state: EditorState, tr: Transaction): EditorState => {
  let selection = tr.selectionSet ? tr.selection : mapSelection(state.selection, tr.mapping);
  if (selection.node) {
    const found = nodeAt(tr.doc, selection.anchor, state.schema);
    if (!found || selection.head !== selection.anchor + nodeSize(found.node, state.schema)) {
      selection = { anchor: selection.anchor, head: selection.anchor };
    }
  }
  let storedMarks = state.storedMarks;
  if (tr.storedMarksSet) storedMarks = tr.storedMarks;
  else if (tr.docChanged || tr.selectionSet) storedMarks = null;
  return { ...state, doc: tr.doc, selection, storedMarks };
};
