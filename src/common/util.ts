export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? DeepPartial<U>[]
    : T[P] extends object
    ? DeepPartial<T[P]>
    : T[P];
};

export type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };
export type WithOptional<T, K extends keyof T> = Omit<T, K> & {
  [P in K]?: T[P];
};

export const callWithDelay = <T>(callback: () => Promise<T>, delay: number) => {
  return new Promise((res) => setTimeout(() => res(callback()), delay));
};

export const getRandomId = () => {
  return (65536 + Math.floor(Math.random() * 983040)).toString(16);
};
