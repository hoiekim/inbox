/**
 * Tests for fetch-parsers.ts (IMAP FETCH command parsing)
 * Covers FETCH data items for inbox #340
 */

import { describe, it, expect } from "bun:test";
import { parseCommand } from "./index";
import type { FetchDataItem } from "../types";

function parseFetch(args: string) {
  const result = parseCommand(`A001 FETCH ${args}`);
  if (!result.success || result.value?.request.type !== "FETCH") {
    throw new Error(`FETCH parse failed: ${result.error}`);
  }
  return result.value.request.data as { sequenceSet: unknown; dataItems: FetchDataItem[] };
}

// ---------------------------------------------------------------------------
// Simple data items
// ---------------------------------------------------------------------------

describe("fetch-parsers > simple data items", () => {
  const simpleItems = [
    "ENVELOPE",
    "FLAGS",
    "INTERNALDATE",
    "RFC822",
    "RFC822.HEADER",
    "RFC822.SIZE",
    "RFC822.TEXT",
    "UID",
    "BODYSTRUCTURE",
  ];

  for (const item of simpleItems) {
    it(`should parse ${item} as single item`, () => {
      const data = parseFetch(`1 ${item}`);
      expect(data.dataItems).toHaveLength(1);
      expect(data.dataItems[0].type).toBe(item);
    });
  }
});

// ---------------------------------------------------------------------------
// Sequence sets
// ---------------------------------------------------------------------------

describe("fetch-parsers > sequence sets", () => {
  it("should parse single message number", () => {
    const data = parseFetch("1 FLAGS");
    expect(data.dataItems[0].type).toBe("FLAGS");
  });

  it("should parse range sequence", () => {
    const data = parseFetch("1:10 FLAGS");
    expect(data.dataItems[0].type).toBe("FLAGS");
  });

  it("should parse wildcard sequence", () => {
    const data = parseFetch("1:* FLAGS");
    expect(data.dataItems[0].type).toBe("FLAGS");
  });
});

// ---------------------------------------------------------------------------
// Parenthesized list of data items
// ---------------------------------------------------------------------------

describe("fetch-parsers > parenthesized lists", () => {
  it("should parse (FLAGS) as a list with one item", () => {
    const data = parseFetch("1 (FLAGS)");
    expect(data.dataItems).toHaveLength(1);
    expect(data.dataItems[0].type).toBe("FLAGS");
  });

  it("should parse (FLAGS UID) as a list with two items", () => {
    const data = parseFetch("1 (FLAGS UID)");
    expect(data.dataItems).toHaveLength(2);
    expect(data.dataItems[0].type).toBe("FLAGS");
    expect(data.dataItems[1].type).toBe("UID");
  });

  it("should parse (FLAGS UID ENVELOPE) as a list with three items", () => {
    const data = parseFetch("1 (FLAGS UID ENVELOPE)");
    expect(data.dataItems).toHaveLength(3);
    expect(data.dataItems.map((i) => i.type)).toEqual(["FLAGS", "UID", "ENVELOPE"]);
  });

  it("should parse (RFC822.SIZE INTERNALDATE) correctly", () => {
    const data = parseFetch("1 (RFC822.SIZE INTERNALDATE)");
    expect(data.dataItems).toHaveLength(2);
    expect(data.dataItems[0].type).toBe("RFC822.SIZE");
    expect(data.dataItems[1].type).toBe("INTERNALDATE");
  });
});

// ---------------------------------------------------------------------------
// BODY data items
// ---------------------------------------------------------------------------

describe("fetch-parsers > BODY data items", () => {
  it("should parse BODY as full body fetch", () => {
    const data = parseFetch("1 BODY");
    expect(data.dataItems).toHaveLength(1);
    expect(data.dataItems[0].type).toBe("BODY");
    const bodyItem = data.dataItems[0];
    if (bodyItem.type !== "BODY") throw new Error("expected BODY");
    expect(bodyItem.peek).toBe(false);
  });

  it("should parse BODY[] as full body fetch", () => {
    const data = parseFetch("1 BODY[]");
    expect(data.dataItems).toHaveLength(1);
    expect(data.dataItems[0].type).toBe("BODY");
    const bodyItem = data.dataItems[0];
    if (bodyItem.type !== "BODY") throw new Error("expected BODY");
    expect(bodyItem.section?.type).toBe("FULL");
  });

  it("should parse BODY.PEEK[] as peek body fetch", () => {
    const data = parseFetch("1 BODY.PEEK[]");
    expect(data.dataItems).toHaveLength(1);
    expect(data.dataItems[0].type).toBe("BODY");
    const bodyItem = data.dataItems[0];
    if (bodyItem.type !== "BODY") throw new Error("expected BODY");
    expect(bodyItem.peek).toBe(true);
  });

  it("should parse BODY[HEADER]", () => {
    const data = parseFetch("1 BODY[HEADER]");
    expect(data.dataItems).toHaveLength(1);
    const bodyItem = data.dataItems[0];
    if (bodyItem.type !== "BODY") throw new Error("expected BODY");
    expect(bodyItem.section?.type).toBe("HEADER");
  });

  it("should parse BODY[TEXT]", () => {
    const data = parseFetch("1 BODY[TEXT]");
    const bodyItem = data.dataItems[0];
    if (bodyItem.type !== "BODY") throw new Error("expected BODY");
    expect(bodyItem.section?.type).toBe("TEXT");
  });

  it("should parse BODY[HEADER.FIELDS (FROM TO SUBJECT DATE)]", () => {
    const data = parseFetch("1 BODY[HEADER.FIELDS (FROM TO SUBJECT DATE)]");
    expect(data.dataItems).toHaveLength(1);
    const bodyItem = data.dataItems[0];
    if (bodyItem.type !== "BODY") throw new Error("expected BODY");
    expect(bodyItem.section?.type).toBe("HEADER_FIELDS");
    if (bodyItem.section?.type !== "HEADER_FIELDS") throw new Error("expected HEADER_FIELDS section");
    expect(bodyItem.section.fields).toContain("FROM");
    expect(bodyItem.section.fields).toContain("TO");
    expect(bodyItem.section.fields).toContain("SUBJECT");
    expect(bodyItem.section.fields).toContain("DATE");
  });

  it("should parse BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)]", () => {
    const data = parseFetch("1 BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)]");
    const bodyItem = data.dataItems[0];
    if (bodyItem.type !== "BODY") throw new Error("expected BODY");
    expect(bodyItem.peek).toBe(true);
    expect(bodyItem.section?.type).toBe("HEADER_FIELDS");
  });

  it("should parse BODY[1] for first MIME part", () => {
    const data = parseFetch("1 BODY[1]");
    const bodyItem = data.dataItems[0];
    if (bodyItem.type !== "BODY") throw new Error("expected BODY");
    expect(bodyItem.section?.type).toBe("MIME_PART");
  });

  it("should parse BODY[] with partial range <0.2048>", () => {
    const data = parseFetch("1 BODY[]<0.2048>");
    const bodyItem = data.dataItems[0];
    if (bodyItem.type !== "BODY") throw new Error("expected BODY");
    expect(bodyItem.partial).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Common FETCH combinations (iOS Mail / Thunderbird patterns)
// ---------------------------------------------------------------------------

describe("fetch-parsers > real-world FETCH patterns", () => {
  it("should parse (UID FLAGS ENVELOPE BODYSTRUCTURE) — typical list view", () => {
    const data = parseFetch("1:* (UID FLAGS ENVELOPE BODYSTRUCTURE)");
    const types = data.dataItems.map((i) => i.type);
    expect(types).toContain("UID");
    expect(types).toContain("FLAGS");
    expect(types).toContain("ENVELOPE");
    expect(types).toContain("BODYSTRUCTURE");
  });

  it("should parse (UID BODY.PEEK[]) — full message fetch", () => {
    const data = parseFetch("1 (UID BODY.PEEK[])");
    const types = data.dataItems.map((i) => i.type);
    expect(types).toContain("UID");
    expect(types).toContain("BODY");
  });

  it("should parse (UID RFC822.SIZE INTERNALDATE FLAGS) — metadata fetch", () => {
    const data = parseFetch("1:* (UID RFC822.SIZE INTERNALDATE FLAGS)");
    const types = data.dataItems.map((i) => i.type);
    expect(types).toContain("UID");
    expect(types).toContain("RFC822.SIZE");
    expect(types).toContain("INTERNALDATE");
    expect(types).toContain("FLAGS");
  });
});
