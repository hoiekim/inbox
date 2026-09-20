import { describe, it, expect } from "bun:test";
import { isEnvelopeAligned } from "./alignment";

describe("isEnvelopeAligned", () => {
  it("aligns an envelope sender that shares the header sender's domain", () => {
    expect(isEnvelopeAligned("notifications@github.com", "bounces+9f@github.com")).toBe(true);
  });

  it("aligns identical addresses", () => {
    expect(isEnvelopeAligned("a@example.com", "a@example.com")).toBe(true);
  });

  it("compares domains case-insensitively", () => {
    expect(isEnvelopeAligned("Spammer@UT-Allow.Example", "bounce@ut-allow.example")).toBe(true);
  });

  it("refuses an envelope sender on a different domain", () => {
    expect(isEnvelopeAligned("spammer@ut-allow.example", "envelope-sender@external.example")).toBe(
      false
    );
  });

  it("refuses a subdomain of the header domain", () => {
    expect(isEnvelopeAligned("a@example.com", "b@mail.example.com")).toBe(false);
  });

  it("refuses a header domain that merely ends with the envelope domain", () => {
    expect(isEnvelopeAligned("a@notexample.com", "b@example.com")).toBe(false);
  });

  it("refuses a missing envelope sender", () => {
    expect(isEnvelopeAligned("a@example.com", undefined)).toBe(false);
  });

  it("refuses an empty envelope sender (MAIL FROM:<>)", () => {
    expect(isEnvelopeAligned("a@example.com", "")).toBe(false);
  });

  it("refuses a missing header sender", () => {
    expect(isEnvelopeAligned(undefined, "a@example.com")).toBe(false);
  });

  it("refuses an address with no domain part", () => {
    expect(isEnvelopeAligned("a@example.com", "postmaster")).toBe(false);
  });

  it("refuses an address with a trailing @ and empty domain", () => {
    expect(isEnvelopeAligned("a@example.com", "b@")).toBe(false);
  });

  it("refuses an address with an empty local part", () => {
    expect(isEnvelopeAligned("a@example.com", "@example.com")).toBe(false);
  });

  it("refuses a multi-@ address whose middle component would otherwise align", () => {
    expect(isEnvelopeAligned("a@example.com@evil.test", "b@example.com")).toBe(false);
    expect(isEnvelopeAligned("a@example.com", "b@example.com@evil.test")).toBe(false);
    expect(isEnvelopeAligned("a@example.com@evil.test", "b@example.com@evil.test")).toBe(false);
  });
});
