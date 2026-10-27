import type { Step } from "./steps";
import { Transaction, type EditorState, type Selection } from "./state";

interface Item {
  /** Inverted steps, in the order they must be applied. */
  steps: Step[];
  selection: Selection;
  time: number;
}

/** Edits closer together than this are undone as one. */
const GROUP_MS = 500;
const DEPTH = 100;

/** Undo history: each entry holds the inverted steps of one group of edits. */
export class History {
  private done: Item[] = [];
  private undone: Item[] = [];

  record(tr: Transaction, selectionBefore: Selection, now = Date.now()) {
    if (!tr.docChanged) return;
    const inverted = tr.inverses.slice().reverse();
    const last = this.done[this.done.length - 1];
    if (last && now - last.time < GROUP_MS) {
      last.steps = [...inverted, ...last.steps];
      last.time = now;
    } else {
      this.done.push({ steps: inverted, selection: selectionBefore, time: now });
      if (this.done.length > DEPTH) this.done.shift();
    }
    this.undone = [];
  }

  /** Separates the next edit from the previous group. */
  closeGroup() {
    const last = this.done[this.done.length - 1];
    if (last) last.time = 0;
  }

  get canUndo() {
    return this.done.length > 0;
  }

  get canRedo() {
    return this.undone.length > 0;
  }

  undo(state: EditorState): Transaction | null {
    return this.move(state, this.done, this.undone);
  }

  redo(state: EditorState): Transaction | null {
    return this.move(state, this.undone, this.done);
  }

  private move(state: EditorState, from: Item[], to: Item[]): Transaction | null {
    const item = from.pop();
    if (!item) return null;
    const tr = new Transaction(state);
    for (const step of item.steps) tr.maybeStep(step);
    if (!tr.docChanged) return this.move(state, from, to);
    to.push({ steps: tr.inverses.slice().reverse(), selection: state.selection, time: 0 });
    tr.setSelection(item.selection);
    tr.setMeta("history", true);
    return tr;
  }
}
