import { Constructor } from "./miscellaneous";

/**
 * Similar to Object.assign, but it deep-copies the source's data and uses
 * `clone` method of the source's object if it exists. Also it doesn't copy
 * any functions.
 * @param target
 * @param source
 * @returns target with source's data copied to it.
 * @example
 * const target = { a: 1 };
 * const source = { b: () => 2, c: 3 };
 * const result = assign(target, source);
 * console.log(result); // { a: 1, c: 3 }
 */
const assign = (target: any, source: any) => {
  for (const key in source) {
    const value = source[key];
    if (typeof value === "function") continue;
    if (Array.isArray(value)) {
      target[key] = assign([], value);
    } else if (typeof value === "object" && value !== null) {
      if (typeof value.clone === "function") {
        target[key] = value.clone();
      } else if (value instanceof Date) {
        target[key] = new Date(value);
      } else {
        target[key] = assign({}, value);
      }
    } else {
      target[key] = value;
    }
  }
  return target;
};

/**
 * Overrides all properties in `source` to `target` except for the properties that
 * match names in `exclude` list.
 */
const override = (target: any, source: any, exclude: string[] = []) => {
  for (const prop of Object.getOwnPropertyNames(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, prop)!;
    if (exclude.includes(prop)) continue;
    Object.defineProperty(target, prop, descriptor);
  }
  return target;
};

/**
 * A base class for all models. Models are instantiable with optional properties to
 * "prefill" the instance and have `clone` method that deep-copies the instance.
 *
 * In order to have a model prefillable, use `Model.prefillable` decorator. In
 * order to add `clone` method, extend `Model` class with the child class as a type
 * parameter.
 *
 * @example
 * //@Model.prefillable
 * class ExtendedModel extends Model<ExtendedModel> {
 *   prop = 123;
 * }
 * const a = new ExtendedModel({ prop: 456 })
 * const b = a.clone();
 */
export class Model<T = unknown> {
  /**
   * Class decorator that makes a class instantiable with optional properties to
   * "prefill" the instance.
   */
  static prefillable = <C extends Constructor>(constFunc: C) => {
    //@ts-ignore
    class ExtendedClass extends constFunc {
      constructor(init?: Partial<InstanceType<C>>) {
        super(init);
        if (init) assign(this, init);
      }
    }

    return override(ExtendedClass, constFunc, ["prototype"]) as C & {
      new (init?: Partial<InstanceType<C>>): InstanceType<C>;
    };
  };

  /**
   * Mixes `Model` into a given class and returns the mixed class. All methods in
   * `Model` will be overriden to the target class except for the constructor.
   * @param constFunc a class to be mixed into.
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
    if (init) assign(this, init);
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
