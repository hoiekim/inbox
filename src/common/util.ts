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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Screen an id before it reaches a query against a `uuid` column. Postgres
 * answers a malformed uuid with a 22P02 error rather than an empty result, so
 * an id that could never have matched anything has to be rejected up front —
 * otherwise a stale bookmark or an old client's cached id becomes a 500 and an
 * alarm page instead of a plain not-found (#747).
 */
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);

export const getRandomId = () => {
  // Use Web Crypto API (available in both browser and Node.js 19+)
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};
