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

  if (port === 993) {
    capabilities.push("STARTTLS");
  }

  return capabilities.join(" ");
};
