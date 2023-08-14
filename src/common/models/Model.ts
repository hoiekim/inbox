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
    if (typeof value === "object" && value !== null) {
      // Method name `clone` must be reserved because of the following:
      if ("clone" in value && typeof value.clone === "function") {
        target[key] = value.clone();
      } else if (value instanceof Date) {
        target[key] = new Date(value);
      } else {
        target[key] = assign({}, value);
      }
      continue;
    }
    target[key] = value;
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

    // Un-overrides `constFunc` properties and methods
    for (const prop of Object.getOwnPropertyNames(constFunc)) {
      const descriptor = Object.getOwnPropertyDescriptor(constFunc, prop)!;
      if (prop !== "prototype")
        Object.defineProperty(ExtendedClass, prop, descriptor);
    }

    return ExtendedClass as C & {
      new (init?: Partial<InstanceType<C>>): InstanceType<C>;
    };
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
  clone = (): typeof this => {
    const constructor = this.constructor as Constructor;
    return new constructor(this) as typeof this;
  };
}
