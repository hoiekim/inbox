import { isTlsAvailable } from "../tls";

export const getCapabilities = (isTls = false) => {
  const capabilities = [
    "IMAP4rev1",
    "LITERAL+",
    "SASL-IR",
    "LOGIN-REFERRALS",
    "ID",
    "ENABLE",
    "IDLE",
    "MOVE",
    "CONDSTORE",
    // No SPECIAL-USE here on purpose. RFC 6154 §2 is explicit that the
    // attributes `getMailboxAttributes` emits need no capability on a plain
    // LIST; the capability string denotes the LIST-EXTENDED selection/return
    // options (RFC 5258), which this server's parser rejects. Advertising it
    // would make a client send `LIST (SPECIAL-USE) "" "*"` and get BAD.
    "AUTH=PLAIN"
  ];

  // Plain port: advertise STARTTLS so clients can upgrade — but only when the
  // certificate the upgrade reads is one this process can actually read.
  // RFC 2595 §3: a server must not advertise a capability it cannot honour,
  // and a client that honours this one drives `startTls` into an ENOENT or an
  // EACCES on the cert file.
  // TLS-wrapped port already has an encrypted channel, so it's omitted there.
  if (!isTls && isTlsAvailable()) {
    capabilities.push("STARTTLS");
  }

  return capabilities.join(" ");
};
