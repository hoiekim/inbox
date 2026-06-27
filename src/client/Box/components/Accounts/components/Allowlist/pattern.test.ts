import { describe, it, expect } from "bun:test";
import { isValidAllowlistPattern } from "./pattern";

describe("isValidAllowlistPattern", () => {
  it("accepts an exact email address", () => {
    expect(isValidAllowlistPattern("friend@example.com")).toBe(true);
  });

  it("accepts a domain wildcard", () => {
    expect(isValidAllowlistPattern("*@example.com")).toBe(true);
  });

  it("accepts a multi-label domain", () => {
    expect(isValidAllowlistPattern("alerts@mail.example.co.uk")).toBe(true);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(isValidAllowlistPattern("  friend@example.com  ")).toBe(true);
  });

  it("rejects empty input", () => {
    expect(isValidAllowlistPattern("")).toBe(false);
    expect(isValidAllowlistPattern("   ")).toBe(false);
  });

  it("rejects a bare local part with no domain", () => {
    expect(isValidAllowlistPattern("friend")).toBe(false);
  });

  it("rejects a domain with no TLD", () => {
    expect(isValidAllowlistPattern("friend@example")).toBe(false);
    expect(isValidAllowlistPattern("*@example")).toBe(false);
  });

  it("rejects an empty local part", () => {
    expect(isValidAllowlistPattern("@example.com")).toBe(false);
  });

  it("rejects input containing whitespace inside the address", () => {
    expect(isValidAllowlistPattern("a b@example.com")).toBe(false);
  });

  it("rejects a double-@ address", () => {
    expect(isValidAllowlistPattern("a@b@example.com")).toBe(false);
  });
});
