import { afterEach, describe, expect, it } from "bun:test";
import { getCapabilities } from "./capabilities";
import { getImapPort } from "./index";

describe("IMAP capabilities", () => {
  it("advertises STARTTLS on the plain port", () => {
    expect(getCapabilities(false).split(" ")).toContain("STARTTLS");
  });

  it("does not advertise STARTTLS on the TLS-wrapped port", () => {
    expect(getCapabilities(true).split(" ")).not.toContain("STARTTLS");
  });

  it("defaults to plain (advertises STARTTLS) when called with no args", () => {
    expect(getCapabilities().split(" ")).toContain("STARTTLS");
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
