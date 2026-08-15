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
    "AUTH=PLAIN"
  ];

  // Plain port: advertise STARTTLS so clients can upgrade — but only when the
  // certificate the upgrade reads is actually there. RFC 2595 §3: a server must
  // not advertise a capability it cannot honour, and a client that honours the
  // advertisement drives `startTls` into an ENOENT on the cert file.
  // TLS-wrapped port already has an encrypted channel, so it's omitted there.
  if (!isTls && isTlsAvailable()) {
    capabilities.push("STARTTLS");
  }

  return capabilities.join(" ");
};
