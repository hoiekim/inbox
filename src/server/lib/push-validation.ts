import net from "net";
import { PushSubscription } from "web-push";

export type PushSubscriptionValidation =
  | { valid: true; subscription: PushSubscription }
  | { valid: false; message: string };

const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 256;

/**
 * Suffixes reserved for names that resolve inside the deployment's own network
 * (RFC 6761 / RFC 8375 / mDNS) plus the cloud metadata zone.
 */
const INTERNAL_HOSTNAME_SUFFIXES = [
  ".local",
  ".localhost",
  ".internal",
  ".home.arpa",
];

const isBoundedString = (value: unknown, maxLength: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maxLength;

/**
 * A push endpoint is a URL this server later POSTs to, so an unconstrained one
 * is a server-side request forgery primitive. Rather than enumerating private
 * CIDRs, this rejects every IP literal and every name that can only resolve on
 * an internal network: no real push service is reachable at a bare address.
 *
 * A public name whose DNS record points at a private address still passes —
 * that residual needs resolution-time filtering, not URL parsing.
 */
const findEndpointUrlProblem = (endpoint: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "subscription.endpoint must be a valid URL";
  }

  if (url.protocol !== "https:") {
    return "subscription.endpoint must use https";
  }

  if (url.username || url.password) {
    return "subscription.endpoint must not embed credentials";
  }

  // URL keeps an IPv6 literal bracketed and preserves a fully-qualified
  // trailing dot; net.isIP and suffix matching both need those removed.
  const bracketed = url.hostname.startsWith("[") && url.hostname.endsWith("]");
  const hostname = (bracketed ? url.hostname.slice(1, -1) : url.hostname).replace(/\.+$/, "");

  if (net.isIP(hostname)) {
    return "subscription.endpoint must address a push service by hostname, not by IP";
  }

  if (!hostname.includes(".")) {
    return "subscription.endpoint must use a fully qualified hostname";
  }

  if (INTERNAL_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return "subscription.endpoint must not address an internal hostname";
  }

  return undefined;
};

/**
 * Narrows an untrusted request body field to a storable `PushSubscription`.
 * Returns a rebuilt subscription carrying only the three fields the sender
 * needs, so nothing else a caller attached reaches the push client.
 *
 * @example
 * const validation = validatePushSubscription(req.body.subscription);
 * if (!validation.valid) return { status: "failed", message: validation.message };
 */
export const validatePushSubscription = (
  input: unknown
): PushSubscriptionValidation => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, message: "subscription must be an object" };
  }

  const { endpoint, keys } = input as Record<string, unknown>;

  if (!isBoundedString(endpoint, MAX_ENDPOINT_LENGTH)) {
    return {
      valid: false,
      message: `subscription.endpoint must be a string of 1 to ${MAX_ENDPOINT_LENGTH} characters`,
    };
  }

  const endpointProblem = findEndpointUrlProblem(endpoint);
  if (endpointProblem) return { valid: false, message: endpointProblem };

  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    return { valid: false, message: "subscription.keys must be an object" };
  }

  const { p256dh, auth } = keys as Record<string, unknown>;

  if (!isBoundedString(p256dh, MAX_KEY_LENGTH)) {
    return {
      valid: false,
      message: `subscription.keys.p256dh must be a string of 1 to ${MAX_KEY_LENGTH} characters`,
    };
  }

  if (!isBoundedString(auth, MAX_KEY_LENGTH)) {
    return {
      valid: false,
      message: `subscription.keys.auth must be a string of 1 to ${MAX_KEY_LENGTH} characters`,
    };
  }

  return { valid: true, subscription: { endpoint, keys: { p256dh, auth } } };
};
