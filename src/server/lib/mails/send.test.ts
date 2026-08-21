import { describe, it, expect, beforeAll } from "bun:test";
import { addressField, parseAddressList } from "./send";

describe("parseAddressList — case normalization (#573)", () => {
  it("lowercases a single address", () => {
    expect(parseAddressList("Hoie@Hoie.Kim")).toEqual([
      { address: "hoie@hoie.kim" }
    ]);
  });

  it("splits, trims, and lowercases a comma-separated list", () => {
    expect(parseAddressList("Alice@X.com,  Bob@Y.COM ")).toEqual([
      { address: "alice@x.com" },
      { address: "bob@y.com" }
    ]);
  });

  it("drops empty entries", () => {
    expect(parseAddressList("a@x.com,, , b@x.com")).toEqual([
      { address: "a@x.com" },
      { address: "b@x.com" }
    ]);
  });

  it("returns an empty list for an empty string", () => {
    expect(parseAddressList("")).toEqual([]);
  });
});

describe("addressField — stored recipient fields", () => {
  it("builds a value/text pair from a populated list", () => {
    expect(addressField("Alice@X.com, bob@y.com")).toEqual({
      value: [{ address: "alice@x.com" }, { address: "bob@y.com" }],
      text: "Alice@X.com, bob@y.com"
    });
  });

  it("returns undefined for an empty list so the column stays NULL", () => {
    expect(addressField("")).toBeUndefined();
    expect(addressField(undefined)).toBeUndefined();
  });
});

describe("getSentMail — sender address normalization (#573)", () => {
  // getSentMail builds the *stored* Mail (delivery uses the raw mailToSend via
  // sendMailgunMail). It hits the DB for UID allocation, so the from-address
  // lowercasing is pinned by source inspection rather than a live call. A
  // mixed-case sender must not fragment the Sent account list.
  let fnSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "send.ts"),
      "utf8"
    );
    const match = source.match(/const getSentMail[\s\S]*?\n};/);
    if (!match) throw new Error("getSentMail not found in send.ts");
    fnSource = match[0];
  });

  it("lowercases the constructed from email", () => {
    expect(fnSource).toMatch(
      /fromEmail\s*=\s*`\$\{sender\}@\$\{userDomain\}`\.toLowerCase\(\)/
    );
  });
});
