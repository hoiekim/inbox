import { textContent } from "./model";
import { $ } from "./resolved";
import { emptyDoc, schema } from "./schema";
import {
  chain,
  deleteBackward,
  deleteForward,
  deleteSelection,
  exitCode,
  insertHardBreak,
  insertText,
  joinBackward,
  joinForward,
  liftListItem,
  marksAt,
  selectAll,
  setBlockType,
  sinkListItem,
  splitBlock,
  textblockEndBefore,
  textblockStartAfter,
  toggleBlockType,
  toggleList,
  toggleMark,
  toggleWrap,
  type Command
} from "./commands";
import { History } from "./history";
import { docToHtml } from "./html";
import { htmlToDoc } from "./parse-html";
import { applyTransaction, createState, isEmpty, Transaction, type EditorState } from "./state";
import { contentSize, nodesToItems } from "./tokens";
import { EditorView } from "./view";
import { runInputRules } from "./inputrules";
import { handleCopy, handleDragStart, handleDrop, handlePaste } from "./clipboard";

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export interface EditorOptions {
  /** Initial content as HTML. */
  content?: string;
  /** Shown in the first paragraph while the document is empty. */
  placeholder?: string;
}

const normalizeKey = (event: KeyboardEvent): string => {
  const parts: string[] = [];
  if (isMac ? event.metaKey : event.ctrlKey) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  let key = event.key;
  if (key.length === 1) key = key.toLowerCase();
  // With Alt (or Shift on digits), event.key is the composed character.
  if (event.code.startsWith("Key") && event.altKey) key = event.code.slice(3).toLowerCase();
  if (event.code.startsWith("Digit") && (event.altKey || event.shiftKey)) key = event.code.slice(5);
  parts.push(key);
  return parts.join("-");
};

/**
 * A small rich-text editor: a document model with undoable steps, rendered
 * into a contenteditable element. Content goes in and out as HTML.
 */
export class Editor {
  state: EditorState;
  readonly dom: HTMLElement;
  readonly view: EditorView;
  readonly history = new History();
  private readonly placeholder: string;
  private lastInputRule: { tr: Transaction; before: EditorState } | null = null;
  private updateListeners = new Set<() => void>();
  private keymap: Record<string, () => boolean>;
  isDestroyed = false;

  constructor(options: EditorOptions = {}) {
    this.placeholder = options.placeholder ?? "";
    const doc = options.content ? htmlToDoc(options.content, schema) : emptyDoc();
    const start = textblockStartAfter(doc, 0, schema) ?? 0;
    this.state = createState(schema, doc, { anchor: start, head: start });
    this.keymap = this.buildKeymap();
    this.dom = document.createElement("div");
    this.dom.className = "rich-editor";
    this.view = new EditorView(this.dom, {
      state: this.state,
      dispatch: (tr) => this.dispatch(tr),
      handleKeyDown: (event) => this.handleKeyDown(event),
      handleBeforeInput: (event) => this.handleBeforeInput(event),
      handlePaste: (event) => handlePaste(this, event),
      handleDragStart: (event) => handleDragStart(this, event),
      handleDrop: (event) => handleDrop(this, event),
      onCompositionEnd: () => this.applyInputRules(),
      nodeAttrs: (state) => this.nodeAttrs(state)
    });
    this.dom.addEventListener("copy", (e) => handleCopy(this, e, false));
    this.dom.addEventListener("cut", (e) => handleCopy(this, e, true));
  }

  get doc() {
    return this.state.doc;
  }

  getHTML() {
    return docToHtml(this.doc);
  }

  /**
   * Replaces the whole document. The change can be undone like an edit, but
   * update listeners are not notified.
   */
  setContent(html: string) {
    const doc = htmlToDoc(html, schema);
    const tr = new Transaction(this.state);
    tr.replace(0, contentSize(this.doc, schema), nodesToItems(doc.content ?? [], schema));
    const size = contentSize(tr.doc, schema);
    const end = textblockEndBefore(tr.doc, size, schema) ?? size;
    tr.setSelection({ anchor: end, head: end });
    this.dispatch(tr.setMeta("silent", true));
  }

  dispatch(tr: Transaction) {
    if (this.isDestroyed) return;
    const before = this.state;
    this.state = applyTransaction(this.state, tr);
    if (tr.docChanged && !tr.getMeta("history")) {
      if (tr.getMeta("inputRule")) this.history.closeGroup();
      this.history.record(tr, before.selection);
      if (tr.getMeta("inputRule")) this.history.closeGroup();
    }
    if (!tr.getMeta("inputRule") && (tr.docChanged || tr.selectionSet)) this.lastInputRule = null;
    if (tr.docChanged) this.ensureContent();
    this.view.updateState(this.state);
    if (tr.scrollIntoView && this.view.focused) this.scrollToSelection();
    if (tr.docChanged && !tr.getMeta("silent")) this.updateListeners.forEach((l) => l());
  }

  /** Listens to document changes made by editing; returns an unsubscribe function. */
  onUpdate(fn: () => void) {
    this.updateListeners.add(fn);
    return () => {
      this.updateListeners.delete(fn);
    };
  }

  /** A document always keeps one block to type in. */
  private ensureContent() {
    if ((this.state.doc.content ?? []).length) return;
    const tr = new Transaction(this.state);
    tr.replace(0, 0, [{ o: "paragraph" }, { c: 1 }]);
    tr.setSelection({ anchor: 1, head: 1 });
    this.state = applyTransaction(this.state, tr);
  }

  run(command: Command): boolean {
    return command(this.state, (tr) => this.dispatch(tr));
  }

  focus() {
    this.view.focus();
  }

  undo() {
    const tr = this.history.undo(this.state);
    if (tr) this.dispatch(tr);
    return !!tr;
  }

  redo() {
    const tr = this.history.redo(this.state);
    if (tr) this.dispatch(tr);
    return !!tr;
  }

  insertText(text: string, from?: number, to?: number) {
    const ok = this.run(insertText(text, from, to));
    if (ok && text.length <= 2) this.applyInputRules();
    return ok;
  }

  private applyInputRules() {
    if (!isEmpty(this.state.selection)) return;
    const before = this.state;
    const tr = runInputRules(this.state, this.state.selection.head);
    if (!tr) return;
    this.dispatch(tr);
    this.lastInputRule = { tr, before };
  }

  /** Backspace right after an input rule restores the typed text. */
  private undoInputRule(): boolean {
    const last = this.lastInputRule;
    if (!last) return false;
    this.lastInputRule = null;
    const tr = new Transaction(this.state);
    for (let i = last.tr.inverses.length - 1; i >= 0; i--) {
      if (!tr.maybeStep(last.tr.inverses[i]!)) return false;
    }
    tr.setSelection(last.before.selection);
    this.dispatch(tr);
    return true;
  }

  private scrollToSelection() {
    const rect = this.view.coordsAtPos(this.state.selection.head);
    if (!rect) return;
    const margin = 5;
    for (let el = this.dom.parentElement; el; el = el.parentElement) {
      const overflow = getComputedStyle(el).overflowY;
      if (el.scrollHeight <= el.clientHeight || !/(auto|scroll)/.test(overflow)) continue;
      const box = el.getBoundingClientRect();
      if (rect.bottom > box.bottom - margin) el.scrollTop += rect.bottom - box.bottom + margin;
      else if (rect.top < box.top + margin) el.scrollTop -= box.top + margin - rect.top;
      return;
    }
  }

  private nodeAttrs(state: EditorState) {
    const map = new Map<number, Record<string, string>>();
    if (!this.placeholder) return map;
    const children = state.doc.content ?? [];
    const first = children[0];
    if (children.length === 1 && first?.type === "paragraph" && !(first.content ?? []).length) {
      map.set(0, { "data-placeholder": this.placeholder, class: "is-empty is-editor-empty" });
    }
    return map;
  }

  /** Code block: Enter at the end after two empty lines leaves the block. */
  private exitCodeOnTripleEnter(): boolean {
    const { selection, doc } = this.state;
    if (!isEmpty(selection)) return false;
    const $pos = $(doc, selection.head, schema);
    if (!schema.isCode($pos.parent.type) || !$pos.atEnd) return false;
    if (!textContent($pos.parent).endsWith("\n\n")) return false;
    const tr = new Transaction(this.state);
    tr.delete(selection.head - 2, selection.head);
    const after = $(tr.doc, selection.head - 2, schema).after();
    tr.replace(after, after, [{ o: "paragraph" }, { c: 1 }]);
    tr.setSelection({ anchor: after + 1, head: after + 1 });
    this.dispatch(tr.scroll());
    return true;
  }

  /** Arrow down at the end of a code block that ends the document leaves it. */
  private exitCodeOnArrowDown(): boolean {
    const { selection, doc } = this.state;
    if (!isEmpty(selection)) return false;
    const $pos = $(doc, selection.head, schema);
    if (!schema.isCode($pos.parent.type) || !$pos.atEnd) return false;
    if ($pos.after() < contentSize(doc, schema)) return false;
    return this.run(exitCode);
  }

  /** Arrow right at the end of inline code steps out of it. */
  private exitCodeMark(): boolean {
    const { selection, doc } = this.state;
    if (!isEmpty(selection)) return false;
    const $pos = $(doc, selection.head, schema);
    if (!$pos.atEnd) return false;
    const marks = marksAt(this.state);
    if (!marks.some((m) => m.type === "code")) return false;
    const tr = new Transaction(this.state);
    const rest = marks.filter((m) => m.type !== "code");
    tr.insertText(" ", selection.head, selection.head, rest);
    tr.setSelection({ anchor: selection.head + 1, head: selection.head + 1 });
    tr.setStoredMarks(rest);
    this.dispatch(tr);
    return true;
  }

  private buildKeymap(): Record<string, () => boolean> {
    const c = (command: Command) => () => this.run(command);
    const backspace = () =>
      this.undoInputRule() || this.run(chain(deleteSelection, deleteBackward));
    // With a modifier, deleting within a line (a word, to the line start) is
    // left to the browser and arrives through beforeinput.
    const cursorAt = (edge: "start" | "end") => {
      const { selection, doc } = this.state;
      if (!isEmpty(selection)) return false;
      const $pos = $(doc, selection.head, schema);
      return edge === "start" ? $pos.atStart : $pos.atEnd;
    };
    const modBackspace = () =>
      this.undoInputRule() ||
      this.run(deleteSelection) ||
      (cursorAt("start") && this.run(joinBackward));
    const modDelete = () => this.run(deleteSelection) || (cursorAt("end") && this.run(joinForward));
    const keymap: Record<string, () => boolean> = {
      "Mod-z": () => this.undo(),
      "Mod-Shift-z": () => this.redo(),
      "Mod-y": () => this.redo(),
      "Mod-b": c(toggleMark("bold")),
      "Mod-i": c(toggleMark("italic")),
      "Mod-Shift-s": c(toggleMark("strike")),
      "Mod-e": c(toggleMark("code")),
      "Mod-Alt-0": c(setBlockType("paragraph")),
      "Mod-Alt-c": c(toggleBlockType("codeBlock")),
      "Mod-Shift-7": c(toggleList("orderedList")),
      "Mod-Shift-8": c(toggleList("bulletList")),
      "Mod-Shift-b": c(toggleWrap("blockquote")),
      "Mod-a": c(selectAll),
      Enter: () => this.exitCodeOnTripleEnter() || this.run(splitBlock),
      "Mod-Enter": c(chain(exitCode, insertHardBreak)),
      "Shift-Enter": c(chain(exitCode, insertHardBreak)),
      Tab: c(sinkListItem),
      "Shift-Tab": c(liftListItem),
      Backspace: backspace,
      "Mod-Backspace": modBackspace,
      "Shift-Backspace": modBackspace,
      Delete: c(deleteForward),
      "Mod-Delete": modDelete,
      ArrowDown: () => this.exitCodeOnArrowDown(),
      ArrowRight: () => this.exitCodeMark()
    };
    for (let level = 1; level <= 6; level++) {
      keymap[`Mod-Alt-${level}`] = c(toggleBlockType("heading", { level }));
    }
    return keymap;
  }

  private handleKeyDown(event: KeyboardEvent): boolean {
    let key = normalizeKey(event);
    // On non-Latin layouts, shortcuts fall back to the physical key.
    const latin = event.code.startsWith("Key") ? event.code.slice(3).toLowerCase() : null;
    if (!this.keymap[key] && latin && /-[^-]+$/.test(key)) key = key.replace(/[^-]+$/, latin);
    const binding = this.keymap[key];
    if (!binding) return false;
    // Plain deletes of text go through beforeinput, which knows the target range.
    const plainDelete = key === "Backspace" || key === "Delete";
    if (plainDelete && !this.state.selection.node && !this.lastInputRule) return false;
    return binding();
  }

  private handleBeforeInput(event: InputEvent) {
    const prevent = () => {
      if (event.cancelable) event.preventDefault();
    };
    switch (event.inputType) {
      case "insertText":
        if (this.view.composing || event.isComposing) return;
        prevent();
        this.insertText(event.data ?? "");
        return;
      case "insertReplacementText": {
        prevent();
        const text = event.dataTransfer?.getData("text/plain") ?? event.data ?? "";
        const range = this.targetRange(event);
        this.insertText(text, range?.from, range?.to);
        return;
      }
      case "insertParagraph":
        prevent();
        if (!this.exitCodeOnTripleEnter()) this.run(splitBlock);
        return;
      case "insertLineBreak":
        prevent();
        this.run(chain(exitCode, insertHardBreak));
        return;
      case "deleteContentBackward":
        if (this.view.composing) return;
        prevent();
        if (!this.undoInputRule()) this.run(deleteBackward);
        return;
      case "deleteContentForward":
        prevent();
        this.run(deleteForward);
        return;
      case "deleteWordBackward":
      case "deleteWordForward":
      case "deleteSoftLineBackward":
      case "deleteSoftLineForward":
      case "deleteHardLineBackward":
      case "deleteHardLineForward":
      case "deleteEntireSoftLine":
      case "deleteContent": {
        if (this.view.composing) return;
        prevent();
        if (!isEmpty(this.state.selection)) {
          this.run(deleteSelection);
          return;
        }
        const range = this.targetRange(event);
        if (range && range.from !== range.to) {
          const tr = new Transaction(this.state);
          tr.setSelection({ anchor: range.from, head: range.to });
          this.dispatch(tr);
          this.run(deleteSelection);
        } else if (event.inputType.endsWith("Backward")) {
          this.run(deleteBackward);
        } else {
          this.run(deleteForward);
        }
        return;
      }
      case "deleteByCut":
      case "deleteByDrag":
        prevent();
        this.run(deleteSelection);
        return;
      case "historyUndo":
        prevent();
        this.undo();
        return;
      case "historyRedo":
        prevent();
        this.redo();
        return;
      case "formatBold":
        prevent();
        this.run(toggleMark("bold"));
        return;
      case "formatItalic":
        prevent();
        this.run(toggleMark("italic"));
        return;
      case "formatStrikeThrough":
        prevent();
        this.run(toggleMark("strike"));
        return;
      case "insertCompositionText":
      case "deleteCompositionText":
      case "insertFromComposition":
        return;
      default:
        // Paste and drop are handled by their own events; anything else
        // (underline, alignment, ...) has no place in this schema.
        prevent();
    }
  }

  private targetRange(event: InputEvent): { from: number; to: number } | null {
    const range = event.getTargetRanges?.()[0];
    if (!range) return null;
    const from = this.view.posFromDOM(range.startContainer, range.startOffset);
    const to = this.view.posFromDOM(range.endContainer, range.endOffset);
    if (from === null || to === null) return null;
    return { from: Math.min(from, to), to: Math.max(from, to) };
  }

  destroy() {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.updateListeners.clear();
    this.view.destroy();
  }
}

