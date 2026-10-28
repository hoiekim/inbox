import { describe, expect, it } from "bun:test";
import { decodeBodyBytes, decodeHeaderBytes } from "./charset";

const bytes = (...values: number[]) => Uint8Array.from(values);

describe("utf-16", () => {
  const bigEndianBom = bytes(0xfe, 0xff, 0x00, 0x68, 0x00, 0x69);
  const littleEndianBom = bytes(0xff, 0xfe, 0x68, 0x00, 0x69, 0x00);
  const unmarked = bytes(0x00, 0x68, 0x00, 0x69);

  it("takes the byte order from a BOM and drops the BOM", () => {
    expect(decodeBodyBytes(bigEndianBom, "utf-16")).toBe("hi");
    expect(decodeBodyBytes(littleEndianBom, "UTF-16")).toBe("hi");
    expect(decodeHeaderBytes(bigEndianBom, "utf-16")).toBe("hi");
    expect(decodeHeaderBytes(littleEndianBom, "utf16")).toBe("hi");
  });

  it("reads unmarked text as big-endian", () => {
    expect(decodeBodyBytes(unmarked, "utf-16")).toBe("hi");
    expect(decodeBodyBytes(unmarked, "utf_16")).toBe("hi");
    expect(decodeHeaderBytes(unmarked, "UTF-16")).toBe("hi");
  });

  it("keeps an explicitly labelled byte order", () => {
    expect(decodeBodyBytes(bytes(0x68, 0x00, 0x69, 0x00), "utf-16le")).toBe("hi");
    expect(decodeBodyBytes(unmarked, "utf-16be")).toBe("hi");
  });
});
