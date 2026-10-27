import type { Mark, Node } from "./model";
import { docToHtml } from "./html";
import { cut, insertNodes, textToNodes } from "./fragment";
import { parseHtml } from "./parse-html";
import { $ } from "./resolved";
import type { Schema } from "./schema";
import { isEmpty, selFrom, selTo, Transaction } from "./state";
import { addToMarkSet } from "./steps";
import { build, flatten, textBetween, type Token } from "./tokens";
import { deleteSelection, marksAt } from "./commands";
import type { Editor } from "./editor";

/** Puts the selection on a clipboard or drag as HTML and plain text. */
const writeSelection = (editor: Editor, data: DataTransfer) => {
  const { state } = editor;
  const from = selFrom(state.selection);
  const to = selTo(state.selection);
  const nodes = cut(state.doc, from, to, state.schema);
  data.setData("text/html", docToHtml({ type: "doc", content: nodes }));
  data.setData("text/plain", textBetween(state.doc, from, to, state.schema, "\n\n"));
};

export const handleCopy = (editor: Editor, event: ClipboardEvent, isCut: boolean) => {
  if (isEmpty(editor.state.selection) || !event.clipboardData) return;
  event.preventDefault();
  writeSelection(editor, event.clipboardData);
  if (isCut) editor.run(deleteSelection);
};

/** Markdown-style marks typed out in pasted text: `**bold**` becomes bold, and so on. */
const PASTE_RULES: [RegExp, string, number][] = [
  [/(^|\s)\*\*(?!\s+\*\*)([^*]+)\*\*(?!\s+\*\*)/g, "bold", 2],
  [/(^|\s)__(?!\s+__)([^_]+)__(?!\s+__)/g, "bold", 2],
  [/(^|[^`])`([^`]+)`(?!`)/g, "code", 1],
  [/(^|\s)\*(?!\s+\*)([^*]+)\*(?!\s+\*)/g, "italic", 1],
  [/(^|\s)_(?!\s+_)([^_]+)_(?!\s+_)/g, "italic", 1],
  [/(^|\s)~~(?!\s+~~)([^~]+)~~(?!\s+~~)/g, "strike", 2]
];

const marksOf = (token: Token) =>
  token.kind === "char" ? token.marks : token.kind === "leaf" ? token.node.marks : undefined;

const withMarks = (token: Token, marks: Mark[]): Token => {
  if (token.kind === "char") return { ...token, marks };
  if (token.kind === "leaf") return { ...token, node: { ...token.node, marks } };
  return token;
};

/** Applies the paste rules to one textblock's inline content, one linear pass per rule. */
const markInline = (content: Node[], schema: Schema): Node[] => {
  let tokens = flatten(content, "paragraph", schema);
  for (const [re, type, delimiter] of PASTE_RULES) {
    // Line breaks and other leaves are not whitespace to the rules.
    const text = tokens.map((t) => (t.kind === "char" ? t.ch : "\ufffc")).join("");
    const action = new Uint8Array(tokens.length);
    const DROP = 1;
    const MARK = 2;
    let changed = false;
    for (const m of text.matchAll(re)) {
      const start = m.index! + m[1]!.length;
      const innerEnd = start + delimiter + m[2]!.length;
      const end = innerEnd + delimiter;
      let excluded = false;
      for (let k = start; k < end && !excluded; k++) {
        excluded = !!marksOf(tokens[k]!)?.some(
          (mark) => mark.type !== type && schema.excludes(mark.type, type)
        );
      }
      if (excluded) continue;
      changed = true;
      for (let k = start; k < end; k++) {
        action[k] = k < start + delimiter || k >= innerEnd ? DROP : MARK;
      }
    }
    if (!changed) continue;
    const mark = schema.mark(type);
    tokens = tokens.flatMap((token, k) => {
      if (action[k] === DROP) return [];
      if (action[k] === MARK) return [withMarks(token, addToMarkSet(marksOf(token), mark, schema))];
      return [token];
    });
  }
  return build(tokens) ?? content;
};

const applyPasteRules = (nodes: Node[], schema: Schema): Node[] =>
  nodes.map((node) => {
    if (schema.isCode(node.type) || !node.content) return node;
    if (schema.isTextblock(node.type)) {
      return { ...node, content: markInline(node.content, schema) };
    }
    return { ...node, content: applyPasteRules(node.content, schema) };
  });

const withPasteRules = (nodes: Node[], schema: Schema): Node[] =>
  nodes.every((n) => schema.isInline(n.type))
    ? markInline(nodes, schema)
    : applyPasteRules(nodes, schema);

const isBlank = (nodes: Node[]) =>
  nodes.every((n) => n.type === "paragraph" && !(n.content ?? []).length);

const codeBlockFromVSCode = (data: ReadableData, schema: Schema): Node | null => {
  const text = data.getData("text/plain");
  const raw = data.getData("vscode-editor-data");
  if (!text || !raw) return null;
  try {
    const language = (JSON.parse(raw) as { mode?: unknown }).mode;
    if (typeof language !== "string" || !language) return null;
    const content = [schema.text(text.replace(/\r\n?/g, "\n"))];
    return schema.node("codeBlock", { language }, content);
  } catch {
    return null;
  }
};

export const handlePaste = (editor: Editor, event: ClipboardEvent): boolean => {
  if (!event.clipboardData) return false;
  insertData(editor, event.clipboardData);
  return true;
};

/** The range being dragged out of an editor, so a drop inside it can move the text. */
const dragging = new WeakMap<Editor, { from: number; to: number }>();

export const handleDragStart = (editor: Editor, event: DragEvent) => {
  const { selection } = editor.state;
  if (isEmpty(selection) || !event.dataTransfer) return;
  writeSelection(editor, event.dataTransfer);
  dragging.set(editor, { from: selFrom(selection), to: selTo(selection) });
  editor.dom.addEventListener("dragend", () => dragging.delete(editor), { once: true });
};

/**
 * Inserts dropped content where it lands. Text dragged from within the
 * editor moves, unless the copy modifier is held.
 */
export const handleDrop = (editor: Editor, event: DragEvent): boolean => {
  const source = dragging.get(editor);
  dragging.delete(editor);
  if (!event.dataTransfer) return true;
  const at = editor.view.posAtCoords(event.clientX, event.clientY);
  if (at === null) return true;
  const copy = /Mac|iPhone|iPad/.test(navigator.platform) ? event.altKey : event.ctrlKey;
  let pos = at;
  if (source && !copy) {
    if (at > source.from && at < source.to) return true;
    const state = { ...editor.state, selection: { anchor: source.from, head: source.to } };
    deleteSelection(state, (tr) => {
      pos = tr.mapping.map(at);
      editor.dispatch(tr);
    });
  }
  const place = new Transaction(editor.state);
  place.setSelection({ anchor: pos, head: pos });
  editor.dispatch(place);
  insertData(editor, event.dataTransfer);
  return true;
};

type ReadableData = Pick<DataTransfer, "getData">;

const insertData = (editor: Editor, data: ReadableData) => {
  const { state } = editor;
  const { schema } = state;
  const parentType = $(state.doc, selFrom(state.selection), schema).parent.type;
  const text = data.getData("text/plain");
  if (schema.isCode(parentType)) {
    if (text) editor.run(insertNodes([schema.text(text.replace(/\r\n?/g, "\n"))]));
    return;
  }
  const vscode = codeBlockFromVSCode(data, schema);
  if (vscode) {
    editor.run(insertNodes([vscode]));
    return;
  }
  const html = data.getData("text/html");
  if (html) {
    const nodes = parseHtml(html, schema, { paste: true });
    if (!isBlank(nodes)) {
      editor.run(insertNodes(withPasteRules(nodes, schema)));
      return;
    }
  }
  if (text) {
    const marks: Mark[] = marksAt(state);
    editor.run(insertNodes(withPasteRules(textToNodes(text, schema, marks), schema)));
  }
};
