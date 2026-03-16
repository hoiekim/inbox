export const getCapabilities = (port = 143) => {
  const capabilities = [
    "IMAP4rev1",
    "LITERAL+",
    "SASL-IR",
    "LOGIN-REFERRALS",
    "ID",
    "ENABLE",
    "IDLE",
    "AUTH=PLAIN"
  ];

  if (port === 143) {
    // Advertise STARTTLS on plain port to allow upgrade
    capabilities.push("STARTTLS");
  }
  // Do NOT advertise STARTTLS on port 993 — connection is already TLS-wrapped

  return capabilities.join(" ");
};
