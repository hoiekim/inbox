/**
 * Runtime environment access.
 *
 * Bun's bundler constant-folds the exact member expression `process.env.NODE_ENV`
 * into a literal at build time, and the server ships as a bundle. Written that
 * way, a NODE_ENV check is decided by whatever the *build* saw and the
 * container's environment can no longer change it. Bracket access is left alone,
 * so every NODE_ENV read goes through here.
 */

export const nodeEnv = (): string | undefined => process.env["NODE_ENV"];

export const isProduction = (): boolean => nodeEnv() === "production";
