import { describe, expect, it } from "bun:test";
import { parseAddressHeader } from "./address";

describe("parseAddressHeader", () => {
  it("reads a bare address and a display name", () => {
    expect(parseAddressHeader("a@example.com, Bob <bob@example.com>")).toEqual({
      value: [
        { address: "a@example.com", name: "" },
        { address: "bob@example.com", name: "Bob" }
      ],
      text: 'a@example.com, "Bob" <bob@example.com>'
    });
  });

  it("keeps a comma inside a quoted display name", () => {
    expect(parseAddressHeader('"Doe, John" <john@example.org>').value).toEqual([
      { address: "john@example.org", name: "Doe, John" }
    ]);
  });

  it("decodes encoded-word display names", () => {
    expect(parseAddressHeader("=?UTF-8?B?7ZmN6ri464+Z?= <hong@example.kr>").value).toEqual([
      { address: "hong@example.kr", name: "홍길동" }
    ]);
  });

  it("nests RFC 5322 group members under the group", () => {
    expect(parseAddressHeader('Team: alice@example.org, "Bob B" <bob@example.org>;')).toEqual({
      value: [
        {
          name: "Team",
          group: [
            { address: "alice@example.org", name: "" },
            { address: "bob@example.org", name: "Bob B" }
          ]
        }
      ],
      text: '"Team": alice@example.org, "Bob B" <bob@example.org>;'
    });
  });

  it("shows an IDN domain in Unicode", () => {
    expect(parseAddressHeader("x@xn--9n2bp8q.com").value[0].address).toBe("x@실례.com");
  });

  it("re-parses a display name that is a whole encoded address list", () => {
    const encoded = `=?UTF-8?B?${Buffer.from("A <a@x.org>, b@y.org").toString("base64")}?=`;
    expect(parseAddressHeader(encoded).value).toEqual([
      { address: "a@x.org", name: "A" },
      { address: "b@y.org", name: "" }
    ]);
  });

  it("never promotes a quoted display name over a real address", () => {
    expect(parseAddressHeader('"user@evil.example" other@example.com').value).toEqual([
      { address: "other@example.com", name: "user@evil.example" }
    ]);
  });

  it("reads a comment as the display name when there is no other", () => {
    expect(parseAddressHeader("a@b.c (Alice)").value).toEqual([
      { address: "a@b.c", name: "Alice" }
    ]);
  });

  it("keeps an empty group", () => {
    expect(parseAddressHeader("undisclosed-recipients:;").value).toEqual([
      { name: "undisclosed-recipients", group: [] }
    ]);
  });

  it("treats a semicolon outside a group as a separator", () => {
    expect(parseAddressHeader("a@x.org; b@x.org").value.map((entry) => entry.address)).toEqual([
      "a@x.org",
      "b@x.org"
    ]);
  });
});
