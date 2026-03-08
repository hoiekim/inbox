/**
 * Domain utilities - shared across server modules.
 * Placed here to avoid circular imports that occur when importing through the barrel.
 */

export const getDomain = () => process.env.EMAIL_DOMAIN || "mydomain";

export const getUserDomain = (username: string) => {
  const domain = getDomain();
  if (username === "admin") return domain;
  return `${username}.${domain}`;
};
