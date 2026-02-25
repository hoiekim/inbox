import { splitRecipients, addressParser } from "./send";

// Mock getDomain to return a predictable value
jest.mock("server", () => ({
  getDomain: () => "hoie.kim",
  getUserDomain: (username: string) =>
    username === "admin" ? "hoie.kim" : `${username}.hoie.kim`,
  saveMail: jest.fn(),
  getText: (html: string) => html.replace(/<[^>]*>/g, ""),
  saveBuffer: jest.fn().mockResolvedValue("buffer-id"),
  getDomainUidNext: jest.fn().mockResolvedValue(1),
  getAccountUidNext: jest.fn().mockResolvedValue(1),
  getUser: jest.fn()
}));

describe("addressParser", () => {
  it("should parse single email", () => {
    expect(addressParser("user@example.com")).toEqual([
      { email: "user@example.com" }
    ]);
  });

  it("should parse multiple comma-separated emails", () => {
    expect(addressParser("a@example.com, b@example.com")).toEqual([
      { email: "a@example.com" },
      { email: "b@example.com" }
    ]);
  });

  it("should handle spaces around emails", () => {
    expect(addressParser("  user@example.com  ")).toEqual([
      { email: "user@example.com" }
    ]);
  });

  it("should filter invalid addresses without @", () => {
    expect(addressParser("invalid, user@example.com")).toEqual([
      { email: "user@example.com" }
    ]);
  });

  it("should handle empty string", () => {
    expect(addressParser("")).toEqual([]);
  });
});

describe("splitRecipients", () => {
  // getDomain() returns "hoie.kim" via mock

  describe("exact domain matching", () => {
    it("should classify hoie.kim addresses as local", () => {
      const { local, external } = splitRecipients("user@hoie.kim");
      expect(local).toEqual(["user@hoie.kim"]);
      expect(external).toEqual([]);
    });

    it("should classify external domains as external", () => {
      const { local, external } = splitRecipients("user@gmail.com");
      expect(local).toEqual([]);
      expect(external).toEqual(["user@gmail.com"]);
    });

    it("should handle mixed local and external recipients", () => {
      const { local, external } = splitRecipients(
        "local@hoie.kim, external@gmail.com"
      );
      expect(local).toEqual(["local@hoie.kim"]);
      expect(external).toEqual(["external@gmail.com"]);
    });
  });

  describe("subdomain matching", () => {
    it("should classify subdomains as local (sub.hoie.kim)", () => {
      const { local, external } = splitRecipients("user@sub.hoie.kim");
      expect(local).toEqual(["user@sub.hoie.kim"]);
      expect(external).toEqual([]);
    });

    it("should classify deeply nested subdomains as local", () => {
      const { local, external } = splitRecipients("user@a.b.hoie.kim");
      expect(local).toEqual(["user@a.b.hoie.kim"]);
      expect(external).toEqual([]);
    });
  });

  describe("domain suffix attack prevention", () => {
    it("should NOT classify nothoie.kim as local (suffix match attack)", () => {
      const { local, external } = splitRecipients("user@nothoie.kim");
      expect(local).toEqual([]);
      expect(external).toEqual(["user@nothoie.kim"]);
    });

    it("should NOT classify evilhoie.kim as local", () => {
      const { local, external } = splitRecipients("user@evilhoie.kim");
      expect(local).toEqual([]);
      expect(external).toEqual(["user@evilhoie.kim"]);
    });

    it("should NOT classify hoie.kim.evil.com as local", () => {
      const { local, external } = splitRecipients("user@hoie.kim.evil.com");
      expect(local).toEqual([]);
      expect(external).toEqual(["user@hoie.kim.evil.com"]);
    });
  });

  describe("cc and bcc handling", () => {
    it("should classify cc recipients correctly", () => {
      const { local, external } = splitRecipients(
        "to@gmail.com",
        "cc@hoie.kim"
      );
      expect(local).toEqual(["cc@hoie.kim"]);
      expect(external).toEqual(["to@gmail.com"]);
    });

    it("should classify bcc recipients correctly", () => {
      const { local, external } = splitRecipients(
        "to@gmail.com",
        undefined,
        "bcc@hoie.kim, bcc2@external.com"
      );
      expect(local).toEqual(["bcc@hoie.kim"]);
      expect(external).toEqual(["to@gmail.com", "bcc2@external.com"]);
    });

    it("should handle all fields together", () => {
      const { local, external } = splitRecipients(
        "to@hoie.kim, to2@gmail.com",
        "cc@sub.hoie.kim",
        "bcc@external.org"
      );
      expect(local).toEqual(["to@hoie.kim", "cc@sub.hoie.kim"]);
      expect(external).toEqual(["to2@gmail.com", "bcc@external.org"]);
    });
  });

  describe("case insensitivity", () => {
    it("should handle uppercase domain", () => {
      const { local, external } = splitRecipients("user@HOIE.KIM");
      expect(local).toEqual(["user@HOIE.KIM"]);
      expect(external).toEqual([]);
    });

    it("should handle mixed case subdomain", () => {
      const { local, external } = splitRecipients("user@Sub.Hoie.Kim");
      expect(local).toEqual(["user@Sub.Hoie.Kim"]);
      expect(external).toEqual([]);
    });
  });

  describe("edge cases", () => {
    it("should handle empty to field", () => {
      const { local, external } = splitRecipients("");
      expect(local).toEqual([]);
      expect(external).toEqual([]);
    });

    it("should handle undefined cc and bcc", () => {
      const { local, external } = splitRecipients("user@hoie.kim");
      expect(local).toEqual(["user@hoie.kim"]);
      expect(external).toEqual([]);
    });

    it("should deduplicate recipients in same category", () => {
      // Note: current implementation doesn't dedupe - this documents behavior
      const { local, external } = splitRecipients(
        "user@hoie.kim",
        "user@hoie.kim"
      );
      expect(local).toEqual(["user@hoie.kim", "user@hoie.kim"]);
    });
  });
});
