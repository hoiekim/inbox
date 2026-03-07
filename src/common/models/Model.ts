import { Constructor } from "./miscellaneous";

/**
 * Similar to Object.assign, but it deep-copies the source's data and uses
 * `clone` method of the source's object if it exists. Also it doesn't copy
 * any functions.
 * @returns target with source's data copied to it.
 * @example
 * const target = { a: 1 };
 * const source = { b: () => 2, c: 3 };
 * const result = assign(target, source);
 * console.log(result); // { a: 1, c: 3 }
 */
type AssignTarget = Record<string, unknown> | unknown[];

const assign = <T extends AssignTarget>(target: T, source: AssignTarget): T => {
  const src = source as Record<string, unknown>;
  const tgt = target as Record<string, unknown>;
  for (const key in src) {
    const value = src[key];
    if (typeof value === "function") continue;
    if (Array.isArray(value)) {
      tgt[key] = assign([] as unknown[], value);
    } else if (typeof value === "object" && value !== null) {
      const obj = value as Record<string, unknown>;
      if (typeof obj.clone === "function") {
        tgt[key] = (obj.clone as () => unknown)();
      } else if (value instanceof Date) {
        tgt[key] = new Date(value);
      } else {
        tgt[key] = assign({}, obj);
      }
    } else {
      tgt[key] = value;
    }
  }
  return target;
};

/**
 * Overrides all properties in `source` to `target` except for the properties that
 * match names in `exclude` list.
 * @returns target with source's properties overridden to it.
 */
const override = (target: object, source: object, exclude: string[] = []) => {
  for (const prop of Object.getOwnPropertyNames(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, prop)!;
    if (exclude.includes(prop)) continue;
    Object.defineProperty(target, prop, descriptor);
  }
  return target;
};

export class Model<T = unknown> {
  /**
   * Mixes `Model` into a given class and returns the mixed class. All methods in
   * `Model` will be overriden to the target class except for the constructor.
   * @param constFunc a class to mix `Model` into.
   * @returns the mixed class.
   * @example
   * class MapModel extends Model.mixin(Map<string, string>) {}
   * const map = new MapModel()
   * map.set("name", "Ruby")
   * const cloned = map.clone()
   */
  static mixin = <C extends Constructor>(constFunc: C) => {
    class MixinModel extends constFunc {}
    override(MixinModel.prototype, Model.prototype, ["constructor"]);
    return MixinModel as unknown as C & Constructor<Model>;
  };

  constructor(init?: Partial<T>) {
    if (init) assign(this as unknown as Record<string, unknown>, init as Record<string, unknown>);
  }

  /**
   * Creates a deep-copy of this instance.
   * @returns a new class object that has the same data as this instance.
   * @example
   * const a = new Model();
   * const b = a.clone();
   * console.log(a === b); // false
   */
  clone() {
    const constructor = this.constructor as Constructor<T>;
    return new constructor(this);
  }
}
