import { isProduction } from "../env";
import { trustLoopbackAndPrivate, trustNoProxy, type ProxyTrust } from "./request";

/**
 * Which peers' forwarding headers the app believes, resolved from the
 * *runtime* environment.
 *
 * Trust the proxy by ADDRESS, not by hop count. A hop count trusts whichever
 * peer opened the connection, so a request that reaches the app port without
 * passing the proxy could still name its own `req.ip` through a forwarding
 * header. With an address list, such a peer is untrusted and `req.ip` stays
 * its real socket address.
 */
export const resolveProxyTrust = (): ProxyTrust =>
  isProduction() ? trustLoopbackAndPrivate : trustNoProxy;
