/**
 * Utilities shared across server modules.
 * Placed here to avoid circular imports that occur when importing through the barrel.
 */

export const getDomain = () => process.env.EMAIL_DOMAIN || "mydomain";

export const getUserDomain = (username: string) => {
  const domain = getDomain();
  if (username === "admin") return domain;
  return `${username}.${domain}`;
};

/**
 * Resolves `undefined` if `promise` has not settled within `ms`.
 *
 * For awaits on the shutdown path whose own transport carries no deadline: a
 * hung one holds the stop open until the container's grace period expires and
 * SIGKILL replaces the clean exit.
 */
export const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
