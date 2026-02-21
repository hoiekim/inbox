import { describe, test, expect } from "bun:test";
import { parseColumnDefinition } from "./migration";

describe("parseColumnDefinition", () => {
  test("parses simple types", () => {
    const result = parseColumnDefinition("TEXT");
    expect(result).toBeTruthy();
    expect(result?.pgType).toBe("TEXT");
    expect(result?.nullable).toBe(true);
    expect(result?.hasDefault).toBe(false);
  });

  test("parses NOT NULL constraint", () => {
    const result = parseColumnDefinition("TEXT NOT NULL");
    expect(result).toBeTruthy();
    expect(result?.nullable).toBe(false);
  });

  test("parses DEFAULT values", () => {
    const result = parseColumnDefinition("BOOLEAN NOT NULL DEFAULT FALSE");
    expect(result).toBeTruthy();
    expect(result?.pgType).toBe("BOOLEAN");
    expect(result?.nullable).toBe(false);
    expect(result?.hasDefault).toBe(true);
    expect(result?.defaultValue).toBe("FALSE");
  });

  test("parses UUID with complex default", () => {
    const result = parseColumnDefinition("UUID PRIMARY KEY DEFAULT gen_random_uuid()");
    expect(result).toBeTruthy();
    expect(result?.pgType).toBe("UUID");
    expect(result?.hasDefault).toBe(true);
  });

  test("parses TIMESTAMP types", () => {
    const result = parseColumnDefinition("TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP");
    expect(result).toBeTruthy();
    expect(result?.pgType).toBe("TIMESTAMP");
  });

  test("parses VARCHAR with length", () => {
    const result = parseColumnDefinition("VARCHAR(255) NOT NULL");
    expect(result).toBeTruthy();
    expect(result?.pgType).toBe("VARCHAR");
  });

  test("parses INTEGER", () => {
    const result = parseColumnDefinition("INTEGER NOT NULL DEFAULT 0");
    expect(result).toBeTruthy();
    expect(result?.pgType).toBe("INTEGER");
    expect(result?.defaultValue).toBe("0");
  });

  test("parses JSONB", () => {
    const result = parseColumnDefinition("JSONB");
    expect(result).toBeTruthy();
    expect(result?.pgType).toBe("JSONB");
    expect(result?.nullable).toBe(true);
  });

  test("parses foreign key reference", () => {
    const result = parseColumnDefinition("UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE");
    expect(result).toBeTruthy();
    expect(result?.pgType).toBe("UUID");
    expect(result?.nullable).toBe(false);
  });

  test("parses TSVECTOR", () => {
    const result = parseColumnDefinition("TSVECTOR");
    expect(result).toBeTruthy();
    expect(result?.pgType).toBe("TSVECTOR");
  });
});
