import { describe, expect, it } from "bun:test";
import { createTransferDecoder } from "./transfer-decoder";

/** Feeds `input` in `size`-byte pieces and joins what comes out. */
const decodeInPieces = (encoding: string, input: string | Buffer, size: number): Buffer => {
  const decoder = createTransferDecoder(encoding);
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, "latin1");
  const out: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    out.push(Buffer.from(decoder.write(bytes.subarray(i, i + size))));
  }
  out.push(Buffer.from(decoder.end()));
  return Buffer.concat(out);
};

describe("base64 transfer decoding", () => {
  const payload = Buffer.from(Array.from({ length: 1000 }, (_, i) => (i * 37) % 256));
  const encoded = payload.toString("base64").replace(/.{76}/g, "$&\r\n");

  it("decodes the same bytes whatever the chunking", () => {
    for (const size of [1, 2, 3, 5, 77, 4096]) {
      expect(decodeInPieces("base64", encoded, size).equals(payload)).toBe(true);
    }
  });

  it("skips characters outside the alphabet", () => {
    expect(decodeInPieces("base64", "QU\r\nJD !REVG", 3).toString()).toBe("ABCDEF");
  });

  it("decodes padded quanta and concatenated encodings", () => {
    expect(decodeInPieces("base64", "QQ==", 1).toString()).toBe("A");
    expect(decodeInPieces("base64", "QUI=QUI=", 2).toString()).toBe("ABAB");
    expect(decodeInPieces("base64", "QUI", 1).toString()).toBe("AB");
  });
});

describe("quoted-printable transfer decoding", () => {
  it("decodes escapes and joins soft line breaks", () => {
    expect(decodeInPieces("quoted-printable", "caf=C3=A9 au=\r\n lait\r\n", 1).toString()).toBe(
      "café au lait\r\n"
    );
  });

  it("drops whitespace before a line break but keeps it inside a line", () => {
    expect(decodeInPieces("quoted-printable", "a  b   \r\nc \t\nd  ", 4).toString()).toBe(
      "a  b\r\nc\nd"
    );
  });

  it("leaves an incomplete or invalid escape as written", () => {
    expect(decodeInPieces("quoted-printable", "=ZZ x=4", 2).toString()).toBe("=ZZ x=4");
    expect(decodeInPieces("quoted-printable", "trailing=", 3).toString()).toBe("trailing");
  });

  it("passes unencoded 8-bit octets through unchanged", () => {
    const raw = Buffer.concat([Buffer.from("x "), Buffer.from("한"), Buffer.from("=41\r\n")]);
    expect(decodeInPieces("quoted-printable", raw, 1).toString("utf8")).toBe("x 한A\r\n");
  });

  it("decodes a line longer than its carry limit without losing an escape at the cut", () => {
    const line = "=41".repeat(30000) + "=42";
    const decoded = decodeInPieces("quoted-printable", line, 50000).toString();
    expect(decoded).toBe("A".repeat(30000) + "B");
  });
});

describe("identity transfer decoding", () => {
  it("passes 7bit, 8bit and binary through", () => {
    expect(decodeInPieces("8bit", "abc\r\n", 2).toString()).toBe("abc\r\n");
  });
});
