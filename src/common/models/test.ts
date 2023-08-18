import { Model } from "./Model";

@Model.prefillable
class Foo extends Model<Foo> {
  prop: number[] = [];
}

const foo = new Foo({ prop: [1, 2, 3] });
console.log(foo);
console.log(foo.clone());
