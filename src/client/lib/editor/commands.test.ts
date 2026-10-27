import { describe, expect, test } from "bun:test";
import type { Node } from "./model";
import { schema } from "./schema";
import { applyTransaction, createState, type EditorState, type Selection } from "./state";
import {
  deleteBackward,
  insertHardBreak,
  insertText,
  joinBackward,
  liftListItem,
  setBlockType,
  sinkListItem,
  splitBlock,
  toggleBlockType,
  toggleList,
  toggleMark,
  toggleWrap,
  type Command
} from "./commands";

const text = (t: string): Node => ({ type: "text", text: t });
const p = (t = ""): Node => ({ type: "paragraph", content: t ? [text(t)] : [] });
const doc = (...content: Node[]): Node => ({ type: "doc", content });
const li = (...content: Node[]): Node => ({ type: "listItem", content });
const ul = (...items: Node[]): Node => ({ type: "bulletList", content: items });
const quote = (...content: Node[]): Node => ({ type: "blockquote", content });

/** Drops attrs so assertions focus on structure, text and marks. */
const shape = (node: Node): unknown => {
  if (node.type === "text") {
    return node.marks ? { t: node.text, m: node.marks.map((m) => m.type) } : node.text;
  }
  return { [node.type]: (node.content ?? []).map(shape) };
};

const exec = (d: Node, sel: Selection, ...commands: Command[]) => {
  let state: EditorState = createState(schema, d, sel);
  for (const command of commands) {
    const ok = command(state, (tr) => {
      state = applyTransaction(state, tr);
    });
    if (!ok) throw new Error("command failed");
  }
  return state;
};

const at = (pos: number): Selection => ({ anchor: pos, head: pos });

describe("typing and splitting", () => {
  test("inserts text and splits a paragraph", () => {
    const s = exec(doc(p("ab")), at(2), insertText("X"), splitBlock, insertText("Y"));
    expect(shape(s.doc)).toEqual(shape(doc(p("aX"), p("Yb"))));
    expect(s.selection.head).toBe(6);
  });

  test("Enter at the end of a heading starts a paragraph", () => {
    const h: Node = { type: "heading", attrs: { level: 2 }, content: [text("Hi")] };
    const s = exec(doc(h), at(3), splitBlock);
    expect(s.doc.content![1]!.type).toBe("paragraph");
  });

  test("Backspace joins paragraphs", () => {
    const s = exec(doc(p("ab"), p("cd")), at(5), deleteBackward);
    expect(shape(s.doc)).toEqual(shape(doc(p("abcd"))));
    expect(s.selection.head).toBe(3);
  });

  test("Backspace deletes a whole emoji", () => {
    const s = exec(doc(p("a👍")), at(4), deleteBackward);
    expect(shape(s.doc)).toEqual(shape(doc(p("a"))));
  });

  test("Backspace at the start of a paragraph after a rule deletes the rule", () => {
    const s = exec(doc(p("a"), { type: "horizontalRule" }, p("b")), at(5), deleteBackward);
    expect(shape(s.doc)).toEqual(shape(doc(p("a"), p("b"))));
  });

  test("a hard break keeps the current marks for what is typed next", () => {
    const s = exec(
      doc(p("")),
      at(1),
      toggleMark("bold"),
      insertText("a"),
      insertHardBreak,
      insertText("b")
    );
    expect(shape(s.doc)).toEqual({
      doc: [{ paragraph: [{ t: "a", m: ["bold"] }, { hardBreak: [] }, { t: "b", m: ["bold"] }] }]
    });
  });
});

describe("marks", () => {
  test("toggles bold over a selection", () => {
    const s = exec(doc(p("abcd")), { anchor: 2, head: 4 }, toggleMark("bold"));
    expect(shape(s.doc)).toEqual({ doc: [{ paragraph: ["a", { t: "bc", m: ["bold"] }, "d"] }] });
    const off = exec(s.doc, { anchor: 2, head: 4 }, toggleMark("bold"));
    expect(shape(off.doc)).toEqual(shape(doc(p("abcd"))));
  });

  test("a stored mark applies to typed text", () => {
    const s = exec(doc(p("ab")), at(3), toggleMark("italic"), insertText("c"));
    expect(shape(s.doc)).toEqual({ doc: [{ paragraph: ["ab", { t: "c", m: ["italic"] }] }] });
  });

  test("Enter carries the marks onto the next line", () => {
    const s = exec(
      doc(p("")),
      at(1),
      toggleMark("bold"),
      insertText("a"),
      splitBlock,
      insertText("b")
    );
    expect(shape(s.doc)).toEqual({
      doc: [{ paragraph: [{ t: "a", m: ["bold"] }] }, { paragraph: [{ t: "b", m: ["bold"] }] }]
    });
  });
});

describe("blocks", () => {
  test("toggles a heading", () => {
    const s = exec(doc(p("ab")), at(2), toggleBlockType("heading", { level: 2 }));
    expect(s.doc.content![0]!.type).toBe("heading");
    expect(s.doc.content![0]!.attrs!.level).toBe(2);
    const back = exec(s.doc, at(2), toggleBlockType("heading", { level: 2 }));
    expect(back.doc.content![0]!.type).toBe("paragraph");
  });

  test("Backspace in an empty heading at the top makes it a paragraph", () => {
    const h: Node = { type: "heading", attrs: { level: 1 }, content: [] };
    const s = exec(doc(h, p("x")), at(1), joinBackward);
    expect(s.doc.content![0]!.type).toBe("paragraph");
  });

  test("code blocks drop marks and turn line breaks into newlines", () => {
    const bold: Node = { type: "text", text: "a", marks: [{ type: "bold" }] };
    const s = exec(
      doc({ type: "paragraph", content: [bold, { type: "hardBreak" }, text("b")] }),
      at(1),
      setBlockType("codeBlock")
    );
    expect(shape(s.doc)).toEqual({ doc: [{ codeBlock: ["a\nb"] }] });
  });

  test("retyping keeps the cursor in place", () => {
    const s = exec(doc(p("abc")), at(2), setBlockType("codeBlock"), insertText("X"));
    expect(shape(s.doc)).toEqual({ doc: [{ codeBlock: ["aXbc"] }] });
  });

  test("wraps in a quote and lifts out", () => {
    const s = exec(doc(p("ab")), at(2), toggleWrap("blockquote"));
    expect(shape(s.doc)).toEqual(shape(doc(quote(p("ab")))));
    const back = exec(s.doc, at(3), toggleWrap("blockquote"));
    expect(shape(back.doc)).toEqual(shape(doc(p("ab"))));
  });

  test("Enter in an empty paragraph at the end of a quote leaves the quote", () => {
    const s = exec(doc(quote(p("a"), p())), at(5), splitBlock);
    expect(shape(s.doc)).toEqual(shape(doc(quote(p("a")), p())));
  });
});

describe("lists", () => {
  test("toggles a bullet list on and off", () => {
    const s = exec(doc(p("ab")), at(2), toggleList("bulletList"));
    expect(shape(s.doc)).toEqual(shape(doc(ul(li(p("ab"))))));
    const off = exec(s.doc, at(4), toggleList("bulletList"));
    expect(shape(off.doc)).toEqual(shape(doc(p("ab"))));
  });

  test("switches between list kinds in place", () => {
    const s = exec(doc(ul(li(p("ab")))), at(4), toggleList("orderedList"), insertText("X"));
    expect(shape(s.doc)).toEqual({
      doc: [{ orderedList: [{ listItem: [{ paragraph: ["aXb"] }] }] }]
    });
  });

  test("Enter makes a new item; Enter on an empty item leaves the list", () => {
    const s = exec(doc(ul(li(p("ab")))), at(5), splitBlock, insertText("c"));
    expect(shape(s.doc)).toEqual(shape(doc(ul(li(p("ab")), li(p("c"))))));
    const out = exec(doc(ul(li(p("ab")), li(p("")))), at(9), splitBlock);
    expect(shape(out.doc)).toEqual(shape(doc(ul(li(p("ab"))), p(""))));
  });

  test("sinks and lifts an item", () => {
    const d = doc(ul(li(p("a")), li(p("b"))));
    const sunk = exec(d, at(9), sinkListItem);
    expect(shape(sunk.doc)).toEqual(shape(doc(ul(li(p("a"), ul(li(p("b"))))))));
    const lifted = exec(sunk.doc, at(sunk.selection.head), liftListItem);
    expect(shape(lifted.doc)).toEqual(shape(d));
  });
});
