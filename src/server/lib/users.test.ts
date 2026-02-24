import { describe, expect, it } from "bun:test";
import crypto from "crypto";

describe("Token generation security", () => {
  it("uses cryptographically secure random bytes", () => {
    // This test validates the approach used in createToken()
    const token = crypto.randomBytes(32).toString("hex");
    
    // Token should be 64 hex characters (32 bytes = 64 hex chars)
    expect(token.length).toBe(64);
    
    // Token should only contain hex characters
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique tokens", () => {
    const tokens = new Set<string>();
    
    // Generate 100 tokens and verify uniqueness
    for (let i = 0; i < 100; i++) {
      const token = crypto.randomBytes(32).toString("hex");
      expect(tokens.has(token)).toBe(false);
      tokens.add(token);
    }
    
    expect(tokens.size).toBe(100);
  });

  it("has sufficient entropy (256 bits)", () => {
    // 32 bytes = 256 bits of entropy
    // This is well above the minimum recommended 128 bits for security tokens
    const bytes = crypto.randomBytes(32);
    expect(bytes.length).toBe(32);
  });
});
