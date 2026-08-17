import { afterEach, afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTlsEnvFixture } from "test-helpers";
import { getCapabilities } from "./capabilities";
import { getImapPort, getImapTlsPort } from "./index";

// STARTTLS is now gated on the certificate actually being readable (#763), so
// every case that expects it advertised has to stage real files on disk.
describe("IMAP capabilities", () => {
  let ssl: ReturnType<typeof createTlsEnvFixture>;

  beforeAll(() => {
    ssl = createTlsEnvFixture();
  });

  afterEach(() => ssl.restore());

  afterAll(() => ssl.cleanup());

  it("advertises STARTTLS on the plain port when the certificate exists", () => {
    ssl.use(ssl.certPath, ssl.keyPath);
    expect(getCapabilities(false).split(" ")).toContain("STARTTLS");
  });

  it("does not advertise STARTTLS on the TLS-wrapped port", () => {
    ssl.use(ssl.certPath, ssl.keyPath);
    expect(getCapabilities(true).split(" ")).not.toContain("STARTTLS");
  });

  it("defaults to plain (advertises STARTTLS) when called with no args", () => {
    ssl.use(ssl.certPath, ssl.keyPath);
    expect(getCapabilities().split(" ")).toContain("STARTTLS");
  });

  it("does not advertise STARTTLS when no certificate is configured", () => {
    ssl.use(undefined, undefined);
    expect(getCapabilities(false).split(" ")).not.toContain("STARTTLS");
  });

  it("does not advertise STARTTLS when the configured certificate files are absent", () => {
    ssl.use(ssl.absentPath("absent-cert.pem"), ssl.absentPath("absent-key.pem"));
    expect(getCapabilities(false).split(" ")).not.toContain("STARTTLS");
  });

  it("does not advertise STARTTLS when only the key file is absent", () => {
    ssl.use(ssl.certPath, ssl.absentPath("absent-key.pem"));
    expect(getCapabilities(false).split(" ")).not.toContain("STARTTLS");
  });

  it("keeps every other capability when STARTTLS is withheld", () => {
    ssl.use(undefined, undefined);
    expect(getCapabilities(false).split(" ")).toEqual([
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
    ]);
  });

  it("does not advertise SPECIAL-USE", () => {
    // RFC 6154 §2: the LIST attributes need no capability. The capability
    // string denotes the LIST-EXTENDED selection/return options, and
    // `parseList` rejects `LIST (SPECIAL-USE) "" "*"` outright — advertising
    // it would turn a capability-driven client's discovery into a BAD.
    expect(getCapabilities(false).split(" ")).not.toContain("SPECIAL-USE");
    expect(getCapabilities(true).split(" ")).not.toContain("SPECIAL-USE");
  });
});

describe("getImapPort", () => {
  const original = process.env.IMAP_PORT;
  afterEach(() => {
    if (original === undefined) delete process.env.IMAP_PORT;
    else process.env.IMAP_PORT = original;
  });

  it("returns 143 when IMAP_PORT is unset", () => {
    delete process.env.IMAP_PORT;
    expect(getImapPort()).toBe(143);
  });

  it("returns the configured port from IMAP_PORT", () => {
    process.env.IMAP_PORT = "21001";
    expect(getImapPort()).toBe(21001);
  });

  it("falls back to 143 for non-numeric IMAP_PORT", () => {
    process.env.IMAP_PORT = "not-a-port";
    expect(getImapPort()).toBe(143);
  });
});

describe("getImapTlsPort", () => {
  const original = process.env.IMAP_TLS_PORT;
  afterEach(() => {
    if (original === undefined) delete process.env.IMAP_TLS_PORT;
    else process.env.IMAP_TLS_PORT = original;
  });

  it("returns 993 when IMAP_TLS_PORT is unset", () => {
    delete process.env.IMAP_TLS_PORT;
    expect(getImapTlsPort()).toBe(993);
  });

  it("returns the configured port from IMAP_TLS_PORT", () => {
    process.env.IMAP_TLS_PORT = "9993";
    expect(getImapTlsPort()).toBe(9993);
  });

  it("falls back to 993 for non-numeric IMAP_TLS_PORT", () => {
    process.env.IMAP_TLS_PORT = "not-a-port";
    expect(getImapTlsPort()).toBe(993);
  });
});
