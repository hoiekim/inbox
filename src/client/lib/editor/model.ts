export type Attrs = Record<string, unknown>;

export interface Mark {
  type: string;
  attrs?: Attrs;
}

/**
 * A document node. Documents are plain JSON trees and are treated as
 * immutable: every edit returns a new tree that shares unchanged subtrees
 * with the old one, so object identity tells the view what changed.
 */
export interface Node {
  type: string;
  attrs?: Attrs;
  content?: Node[];
  marks?: Mark[];
  text?: string;
}

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  const ka = Object.keys(a as object).filter((k) => (a as Attrs)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Attrs)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => sameValue((a as Attrs)[k], (b as Attrs)[k]));
};

export const sameAttrs = (a: Attrs | undefined, b: Attrs | undefined): boolean =>
  sameValue(a ?? {}, b ?? {});

export const sameMark = (a: Mark, b: Mark): boolean =>
  a.type === b.type && sameAttrs(a.attrs, b.attrs);

export const sameMarks = (
  a: readonly Mark[] | undefined,
  b: readonly Mark[] | undefined
) => {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  return x.every((m, i) => sameMark(m, y[i]!));
};

export const hasMark = (marks: readonly Mark[] | undefined, mark: Mark) =>
  !!marks?.some((m) => sameMark(m, mark));

export const textContent = (node: Node): string => {
  if (node.text !== undefined) return node.text;
  return (node.content ?? []).map(textContent).join("");
};
