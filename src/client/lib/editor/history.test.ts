import { describe, expect, test } from "bun:test";
import type { Node } from "./model";
import { schema } from "./schema";
import { History } from "./history";
import { applyTransaction, createState, Transaction, type EditorState } from "./state";

const p = (text: string): Node => ({
  type: "paragraph",
  content: text ? [{ type: "text", text }] : []
});
const doc = (...content: Node[]): Node => ({ type: "doc", content });

const typeAt = (history: History, state: EditorState, text: string, pos: number, now: number) => {
  const tr = new Transaction(state);
  tr.insertText(text, pos);
  tr.setSelection({ anchor: pos + text.length, head: pos + text.length });
  history.record(tr, state.selection, now);
  return applyTransaction(state, tr);
};

const run = (state: EditorState, tr: Transaction | null) =>
  tr ? applyTransaction(state, tr) : state;

describe("History", () => {
  test("undoes and redoes an edit, restoring the selection", () => {
    const history = new History();
    const start = createState(schema, doc(p("ab")), { anchor: 3, head: 3 });
    const typed = typeAt(history, start, "c", 3, 1000);
    expect(typed.doc).toEqual(doc(p("abc")));
    const undone = run(typed, history.undo(typed));
    expect(undone.doc).toEqual(doc(p("ab")));
    expect(undone.selection).toEqual({ anchor: 3, head: 3 });
    const redone = run(undone, history.redo(undone));
    expect(redone.doc).toEqual(doc(p("abc")));
  });

  test("groups edits made close together", () => {
    const history = new History();
    let state = createState(schema, doc(p("")), { anchor: 1, head: 1 });
    state = typeAt(history, state, "a", 1, 1000);
    state = typeAt(history, state, "b", 2, 1200);
    state = typeAt(history, state, "c", 3, 5000);
    state = run(state, history.undo(state));
    expect(state.doc).toEqual(doc(p("ab")));
    state = run(state, history.undo(state));
    expect(state.doc).toEqual(doc(p("")));
    expect(history.canUndo).toBe(false);
  });

  test("closeGroup separates the next edit", () => {
    const history = new History();
    let state = createState(schema, doc(p("")), { anchor: 1, head: 1 });
    state = typeAt(history, state, "a", 1, 1000);
    history.closeGroup();
    state = typeAt(history, state, "b", 2, 1100);
    state = run(state, history.undo(state));
    expect(state.doc).toEqual(doc(p("a")));
  });

  test("a new edit clears what could be redone", () => {
    const history = new History();
    let state = createState(schema, doc(p("")), { anchor: 1, head: 1 });
    state = typeAt(history, state, "a", 1, 1000);
    state = run(state, history.undo(state));
    expect(history.canRedo).toBe(true);
    typeAt(history, state, "b", 1, 9000);
    expect(history.canRedo).toBe(false);
  });
});
