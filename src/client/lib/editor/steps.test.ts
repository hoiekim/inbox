import { describe, expect, test } from "bun:test";
import type { Node } from "./model";
import { schema } from "./schema";
import { applyStep, type Step } from "./steps";
import { contentSize, nodesToItems, resolve } from "./tokens";

const p = (...content: (string | Node)[]): Node => ({
  type: "paragraph",
  content: content.map((c) => (typeof c === "string" ? { type: "text", text: c } : c))
});
const doc = (...content: Node[]): Node => ({ type: "doc", content });
const bold = (text: string): Node => ({ type: "text", text, marks: [{ type: "bold" }] });

const apply = (d: Node, step: Step) => applyStep(d, step, schema);

describe("positions", () => {
  test("sizes and resolve", () => {
    const d = doc(p("ab"), p("cd"));
    expect(contentSize(d, schema)).toBe(8);
    const $pos = resolve(d, 2, schema);
    expect($pos.depth).toBe(1);
    expect($pos.textOffset).toBe(1);
    expect(resolve(d, 4, schema).depth).toBe(0);
    expect(resolve(d, 4, schema).indices[0]).toBe(1);
  });
});

describe("replace", () => {
  test("inserts text and inverts", () => {
    const d = doc(p("ab"));
    const r = apply(d, { stepType: "replace", from: 2, to: 2, slice: [{ t: "X" }] });
    expect(r.doc).toEqual(doc(p("aXb")));
    expect(apply(r.doc, r.inverse).doc).toEqual(d);
  });

  test("splits and joins paragraphs", () => {
    const d = doc(p("abcd"));
    const split = apply(d, {
      stepType: "replace",
      from: 3,
      to: 3,
      slice: [{ c: 1 }, { o: "paragraph" }]
    });
    expect(split.doc).toEqual(doc(p("ab"), p("cd")));
    expect(apply(split.doc, { stepType: "replace", from: 3, to: 5, slice: [] }).doc).toEqual(d);
    expect(apply(split.doc, split.inverse).doc).toEqual(d);
  });

  test("reuses untouched siblings", () => {
    const first = p("one");
    const step: Step = { stepType: "replace", from: 7, to: 7, slice: [{ t: "!" }] };
    const r = apply(doc(first, p("two")), step);
    expect(r.doc.content![0]).toBe(first);
  });

  test("rejects content the schema does not allow", () => {
    expect(() => apply(doc(p("ab")), { stepType: "replace", from: 0, to: 4, slice: [] })).toThrow();
    const listItemFirst = nodesToItems([{ type: "horizontalRule" }], schema);
    const list = doc({ type: "bulletList", content: [{ type: "listItem", content: [p("a")] }] });
    expect(() =>
      apply(list, { stepType: "replace", from: 2, to: 2, slice: listItemFirst })
    ).toThrow();
  });

  test("inserts whole nodes", () => {
    const slice = nodesToItems([{ type: "horizontalRule" }], schema);
    const r = apply(doc(p("ab")), { stepType: "replace", from: 4, to: 4, slice });
    expect(r.doc).toEqual(doc(p("ab"), { type: "horizontalRule" }));
  });
});

describe("replaceAround", () => {
  test("retypes a paragraph into a heading keeping content", () => {
    const d = doc(p("ab"));
    const r = apply(d, {
      stepType: "replaceAround",
      from: 0,
      to: 4,
      gapFrom: 1,
      gapTo: 3,
      slice: [{ o: "heading", a: { level: 2 } }, { c: 1 }],
      insert: 1
    });
    expect(r.doc).toEqual(
      doc({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "ab" }] })
    );
    expect(apply(r.doc, r.inverse).doc).toEqual(d);
  });

  test("wraps a paragraph in a list", () => {
    const d = doc(p("ab"));
    const r = apply(d, {
      stepType: "replaceAround",
      from: 0,
      to: 4,
      gapFrom: 0,
      gapTo: 4,
      slice: [{ o: "bulletList" }, { o: "listItem" }, { c: 1 }, { c: 1 }],
      insert: 2
    });
    expect(r.doc).toEqual(
      doc({ type: "bulletList", content: [{ type: "listItem", content: [p("ab")] }] })
    );
    expect(apply(r.doc, r.inverse).doc).toEqual(d);
  });
});

describe("marks", () => {
  test("adds and removes marks", () => {
    const d = doc(p("abcd"));
    const r = apply(d, { stepType: "addMark", from: 2, to: 4, mark: { type: "bold" } });
    expect(r.doc).toEqual(doc(p("a", bold("bc"), "d")));
    expect(apply(r.doc, r.inverse).doc).toEqual(d);
  });

  test("keeps marks in schema order", () => {
    const d = doc(p({ type: "text", text: "x", marks: [{ type: "strike" }] }));
    const r = apply(d, { stepType: "addMark", from: 1, to: 2, mark: { type: "bold" } });
    expect(r.doc.content![0]!.content![0]!.marks).toEqual([{ type: "bold" }, { type: "strike" }]);
  });

  test("inline code excludes other marks", () => {
    const withCode = apply(doc(p(bold("x"))), {
      stepType: "addMark",
      from: 1,
      to: 2,
      mark: { type: "code" }
    });
    expect(withCode.doc.content![0]!.content![0]!.marks).toEqual([{ type: "code" }]);
    const ignored = apply(withCode.doc, {
      stepType: "addMark",
      from: 1,
      to: 2,
      mark: { type: "italic" }
    });
    expect(ignored.doc.content![0]!.content![0]!.marks).toEqual([{ type: "code" }]);
  });

  test("marks are not allowed in code blocks", () => {
    const code = [{ type: "text", text: "x" }];
    const d = doc({ type: "codeBlock", attrs: { language: null }, content: code });
    const r = apply(d, { stepType: "addMark", from: 1, to: 2, mark: { type: "bold" } });
    expect(r.doc).toEqual(d);
  });
});
