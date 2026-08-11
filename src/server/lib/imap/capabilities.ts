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

  if (!isTls) {
    // Plain port: advertise STARTTLS so clients can upgrade.
    // TLS-wrapped port already has an encrypted channel, so it's omitted there.
    capabilities.push("STARTTLS");
  }

  return capabilities.join(" ");
};
