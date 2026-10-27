import { sameMark, sameMarks, type Mark, type Node } from "./model";
import type { Schema } from "./schema";
import {
  build,
  childOffsets,
  flatten,
  fromItems,
  resolve,
  sliceSize,
  toItems,
  type SliceItem,
  type Token
} from "./tokens";

/**
 * Steps are the unit of change. Every edit is a list of steps, each
 * invertible, which is what undo replays.
 */
export type Step =
  | { stepType: "replace"; from: number; to: number; slice: SliceItem[] }
  | {
      // Replaces [from, to) but keeps [gapFrom, gapTo) in place, inserted at
      // position `insert` of the slice. Used to wrap, unwrap and retype
      // blocks without touching their content.
      stepType: "replaceAround";
      from: number;
      to: number;
      gapFrom: number;
      gapTo: number;
      slice: SliceItem[];
      insert: number;
    }
  | { stepType: "addMark"; from: number; to: number; mark: Mark }
  | { stepType: "removeMark"; from: number; to: number; mark: Mark };

export class StepError extends Error {}

/** One replaced range: `[start, start + oldSize)` became `newSize` positions. */
type Range = [start: number, oldSize: number, newSize: number];

export class StepMap {
  static readonly empty = new StepMap([]);
  constructor(readonly ranges: readonly Range[]) {}

  map(pos: number, assoc = 1) {
    let diff = 0;
    for (const [start, oldSize, newSize] of this.ranges) {
      if (start > pos) break;
      const end = start + oldSize;
      if (pos <= end) {
        const side = !oldSize ? assoc : pos === start ? -1 : pos === end ? 1 : assoc;
        return start + diff + (side < 0 ? 0 : newSize);
      }
      diff += newSize - oldSize;
    }
    return pos + diff;
  }
}

/** A sequence of step maps, mapping a position through every step in order. */
export class Mapping {
  readonly maps: StepMap[] = [];

  append(map: StepMap) {
    this.maps.push(map);
  }

  map(pos: number, assoc = 1) {
    for (const map of this.maps) pos = map.map(pos, assoc);
    return pos;
  }
}

export const stepMap = (step: Step): StepMap => {
  switch (step.stepType) {
    case "replace":
      return new StepMap([[step.from, step.to - step.from, sliceSize(step.slice)]]);
    case "replaceAround":
      return new StepMap([
        [step.from, step.gapFrom - step.from, step.insert],
        [step.gapTo, step.to - step.gapTo, sliceSize(step.slice) - step.insert]
      ]);
    default:
      return StepMap.empty;
  }
};

export interface StepResult {
  doc: Node;
  inverse: Step;
  map: StepMap;
}

/**
 * Adds a mark to a set, keeping the set ordered by schema rank. A mark that an
 * existing mark excludes is not added; marks the new one excludes are dropped.
 */
export const addToMarkSet = (marks: readonly Mark[] | undefined, mark: Mark, schema: Schema) => {
  const current = marks ?? [];
  if (current.some((m) => sameMark(m, mark))) return current.slice();
  if (current.some((m) => m.type !== mark.type && schema.excludes(m.type, mark.type))) {
    return current.slice();
  }
  const kept = current.filter((m) => !schema.excludes(mark.type, m.type));
  const next = [...kept, mark];
  next.sort((a, b) => schema.markRank(a.type) - schema.markRank(b.type));
  return next;
};

export const removeFromMarkSet = (marks: readonly Mark[] | undefined, mark: Mark) =>
  (marks ?? []).filter((m) => !sameMark(m, mark));

/** Replaces the child chain along `indices` with `replacement` at `depth`. */
const replaceAlong = (nodes: Node[], indices: number[], depth: number, replacement: Node): Node => {
  let current = replacement;
  for (let d = depth - 1; d >= 0; d--) {
    const parent = nodes[d]!;
    const content = (parent.content ?? []).slice();
    content[indices[d]!] = current;
    current = { ...parent, content };
  }
  return current;
};

const mergeSeams = (children: Node[], seams: number[]): Node[] => {
  const result = children.slice();
  for (const seam of seams.sort((a, b) => b - a)) {
    const left = result[seam - 1];
    const right = result[seam];
    if (!left || !right || left.type !== "text" || right.type !== "text") continue;
    if (!sameMarks(left.marks, right.marks)) continue;
    result.splice(seam - 1, 2, { ...left, text: (left.text ?? "") + (right.text ?? "") });
  }
  return result;
};

/**
 * Splices the token stream in [from, to) with `make(removed)`, operating on
 * the smallest balanced subtree. Returns the new doc and removed tokens.
 */
const splice = (
  doc: Node,
  from: number,
  to: number,
  schema: Schema,
  make: (segment: Token[], a: number, b: number) => Token[]
): { doc: Node; removed: Token[] } => {
  if (from > to) throw new StepError(`Invalid range ${from}..${to}`);
  const $from = resolve(doc, from, schema);
  const $to = resolve(doc, to, schema);
  let shared = 0;
  while (
    shared < $from.depth &&
    shared < $to.depth &&
    $from.nodes[shared + 1] === $to.nodes[shared + 1]
  ) {
    shared++;
  }
  for (let d = shared; d >= 0; d--) {
    const container = $from.nodes[d]!;
    const start = $from.starts[d]!;
    const children = container.content ?? [];
    const offsets = childOffsets(container, schema);
    const localFrom = from - start;
    const localTo = to - start;
    let i = 0;
    while (i < children.length && offsets[i + 1]! <= localFrom) i++;
    let j = i;
    while (j < children.length && offsets[j]! < localTo) j++;
    const segStart = offsets[i]!;
    const segment = flatten(children.slice(i, j), container.type, schema);
    const a = localFrom - segStart;
    const b = localTo - segStart;
    const built = build(make(segment, a, b));
    if (!built) continue;
    const merged = mergeSeams(
      [...children.slice(0, i), ...built, ...children.slice(j)],
      [i, i + built.length]
    );
    if (!schema.validContent(container.type, merged)) {
      throw new StepError(`Invalid content for ${container.type}`);
    }
    for (const node of built) {
      if (schema.check(node)) throw new StepError(`Invalid ${node.type} after edit`);
      for (const mark of node.marks ?? []) {
        if (!schema.allowsMark(container.type, mark.type)) {
          throw new StepError(`Mark ${mark.type} not allowed in ${container.type}`);
        }
      }
    }
    const replacement = { ...container, content: merged };
    return {
      doc: d === 0 ? replacement : replaceAlong($from.nodes, $from.indices, d, replacement),
      removed: segment.slice(a, b)
    };
  }
  throw new StepError(`Unbalanced edit at ${from}..${to}`);
};

const applyReplace = (doc: Node, step: Extract<Step, { stepType: "replace" }>, schema: Schema) => {
  const inserted = fromItems(step.slice);
  const { doc: next, removed } = splice(doc, step.from, step.to, schema, (seg, a, b) => [
    ...seg.slice(0, a),
    ...inserted,
    ...seg.slice(b)
  ]);
  const inverse: Step = {
    stepType: "replace",
    from: step.from,
    to: step.from + inserted.length,
    slice: toItems(removed)
  };
  return { doc: next, inverse, map: stepMap(step) };
};

const applyReplaceAround = (
  doc: Node,
  step: Extract<Step, { stepType: "replaceAround" }>,
  schema: Schema
) => {
  const { from, to, gapFrom, gapTo, insert } = step;
  if (gapFrom < from || gapTo > to || gapFrom > gapTo) throw new StepError("Invalid gap");
  const inserted = fromItems(step.slice);
  if (insert < 0 || insert > inserted.length) throw new StepError("Invalid insert offset");
  let gapSize = 0;
  const { doc: next, removed } = splice(doc, from, to, schema, (seg, a, b) => {
    const gap = seg.slice(a + gapFrom - from, a + gapTo - from);
    gapSize = gap.length;
    return [
      ...seg.slice(0, a),
      ...inserted.slice(0, insert),
      ...gap,
      ...inserted.slice(insert),
      ...seg.slice(b)
    ];
  });
  const before = removed.slice(0, gapFrom - from);
  const after = removed.slice(gapTo - from);
  const inverse: Step = {
    stepType: "replaceAround",
    from,
    to: from + inserted.length + gapSize,
    gapFrom: from + insert,
    gapTo: from + insert + gapSize,
    slice: toItems([...before, ...after]),
    insert: gapFrom - from
  };
  return { doc: next, inverse, map: stepMap(step) };
};

const applyMark = (
  doc: Node,
  step: Extract<Step, { stepType: "addMark" | "removeMark" }>,
  schema: Schema
) => {
  const add = step.stepType === "addMark";
  if (!schema.marks[step.mark.type]) throw new StepError(`Unknown mark ${step.mark.type}`);
  const { doc: next } = splice(doc, step.from, step.to, schema, (seg, a, b) =>
    seg.map((token, i) => {
      if (i < a || i >= b) return token;
      if (token.kind === "char" || token.kind === "leaf") {
        if (!schema.allowsMark(token.parent, step.mark.type)) return token;
        const current = token.kind === "char" ? token.marks : token.node.marks;
        const marks = add
          ? addToMarkSet(current, step.mark, schema)
          : removeFromMarkSet(current, step.mark);
        if (token.kind === "char") {
          const { marks: _old, ...rest } = token;
          return marks.length ? { ...rest, marks } : rest;
        }
        const { marks: _old, ...node } = token.node;
        return { ...token, node: marks.length ? { ...node, marks } : node };
      }
      return token;
    })
  );
  const inverse: Step = { ...step, stepType: add ? "removeMark" : "addMark" };
  return { doc: next, inverse, map: StepMap.empty };
};

export const applyStep = (doc: Node, step: Step, schema: Schema): StepResult => {
  switch (step.stepType) {
    case "replace":
      return applyReplace(doc, step, schema);
    case "replaceAround":
      return applyReplaceAround(doc, step, schema);
    case "addMark":
    case "removeMark":
      return applyMark(doc, step, schema);
  }
};
