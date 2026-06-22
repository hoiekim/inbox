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
    "AUTH=PLAIN"
  ];

  if (!isTls) {
    // Plain port: advertise STARTTLS so clients can upgrade.
    // TLS-wrapped port already has an encrypted channel, so it's omitted there.
    capabilities.push("STARTTLS");
  }

  return capabilities.join(" ");
};
