import { accessSync, constants } from "fs";

const isReadable = (path: string): boolean => {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * TLS credential state, resolved from `SSL_CERTIFICATE` / `SSL_CERTIFICATE_KEY`.
 *
 * `unconfigured` and `unreadable` are kept apart because the callers warn
 * differently: an unset pair is a deliberate plaintext deployment, a set pair
 * pointing at files this process cannot read is a misconfiguration worth
 * naming the paths for.
 */
export type TlsCredentials =
  | { state: "unconfigured" }
  | { state: "unreadable"; cert: string; key: string }
  | { state: "available"; cert: string; key: string };

/**
 * Single source of truth for "can this process serve TLS?", shared by the IMAP
 * listeners, the STARTTLS upgrade, the CAPABILITY response, the SMTP listeners
 * and the health route. Read per call rather than cached at import: certificates
 * are renewed under a running process, and every caller is on a per-connection
 * or per-request path where two `access` syscalls are free.
 */
export const getTlsCredentials = (): TlsCredentials => {
  const { SSL_CERTIFICATE, SSL_CERTIFICATE_KEY } = process.env;
  if (!SSL_CERTIFICATE || !SSL_CERTIFICATE_KEY) return { state: "unconfigured" };
  const cert = SSL_CERTIFICATE;
  const key = SSL_CERTIFICATE_KEY;
  if (!isReadable(cert) || !isReadable(key)) return { state: "unreadable", cert, key };
  return { state: "available", cert, key };
};

export const isTlsAvailable = (): boolean => getTlsCredentials().state === "available";
