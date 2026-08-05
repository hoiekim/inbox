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
    // RFC 6154 §2: LIST reports \Drafts / \Junk on the utility folders, but a
    // client only reads those attributes for role discovery once the server
    // advertises the extension — otherwise it keeps guessing at folder names.
    "SPECIAL-USE",
    "AUTH=PLAIN"
  ];

  if (!isTls) {
    // Plain port: advertise STARTTLS so clients can upgrade.
    // TLS-wrapped port already has an encrypted channel, so it's omitted there.
    capabilities.push("STARTTLS");
  }

  return capabilities.join(" ");
};
