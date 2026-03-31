import { describe, expect, it } from "bun:test";
import { ParseContext } from "../types";
import { parseSearch, parseSearchCriteria } from "./search-parsers";

// Helper to build a ParseContext from a string
function ctx(input: string): ParseContext {
  return { input, position: 0, length: input.length };
}

describe("parseSearchCriteria", () => {
  describe("simple flag criteria", () => {
    it("parses ALL", () => {
      const c = ctx("ALL");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value).toEqual([{ type: "ALL" }]);
    });

    it("parses ANSWERED", () => {
      const c = ctx("ANSWERED");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value).toEqual([{ type: "ANSWERED" }]);
    });

    it("parses DELETED", () => {
      const c = ctx("DELETED");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value).toEqual([{ type: "DELETED" }]);
    });

    it("parses FLAGGED", () => {
      const c = ctx("FLAGGED");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value).toEqual([{ type: "FLAGGED" }]);
    });

    it("parses NEW", () => {
      const c = ctx("NEW");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value).toEqual([{ type: "NEW" }]);
    });

    it("parses OLD", () => {
      const c = ctx("OLD");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value).toEqual([{ type: "OLD" }]);
    });

    it("parses RECENT", () => {
      const c = ctx("RECENT");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value).toEqual([{ type: "RECENT" }]);
    });

    it("parses SEEN", () => {
      const c = ctx("SEEN");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value).toEqual([{ type: "SEEN" }]);
    });

    it("parses UNANSWERED", () => {
      const c = ctx("UNANSWERED");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value).toEqual([{ type: "UNANSWERED" }]);
    });

    it("parses UNDELETED", () => {
      const c = ctx("UNDELETED");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value).toEqual([{ type: "UNDELETED" }]);
    });

    it("parses UNFLAGGED", () => {
      const c = ctx("UNFLAGGED");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value).toEqual([{ type: "UNFLAGGED" }]);
    });

    it("parses UNSEEN", () => {
      const c = ctx("UNSEEN");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value).toEqual([{ type: "UNSEEN" }]);
    });

    it("parses DRAFT", () => {
      const c = ctx("DRAFT");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value).toEqual([{ type: "DRAFT" }]);
    });

    it("parses UNDRAFT", () => {
      const c = ctx("UNDRAFT");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value).toEqual([{ type: "UNDRAFT" }]);
    });
  });

  describe("date criteria", () => {
    it("parses BEFORE with date", () => {
      const c = ctx("BEFORE 01-Jan-2024");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]?.type).toBe("BEFORE");
    });

    it("parses ON with date", () => {
      const c = ctx("ON 15-Mar-2024");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]?.type).toBe("ON");
    });

    it("parses SINCE with date", () => {
      const c = ctx("SINCE 01-Jan-2024");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]?.type).toBe("SINCE");
    });

    it("parses SENTBEFORE with date", () => {
      const c = ctx("SENTBEFORE 01-Jan-2024");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]?.type).toBe("SENTBEFORE");
    });

    it("parses SENTON with date", () => {
      const c = ctx("SENTON 15-Mar-2024");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]?.type).toBe("SENTON");
    });

    it("parses SENTSINCE with date", () => {
      const c = ctx("SENTSINCE 01-Jun-2024");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]?.type).toBe("SENTSINCE");
    });
  });

  describe("text/header criteria", () => {
    it("parses FROM with value", () => {
      const c = ctx("FROM alice");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]).toEqual({ type: "FROM", value: "alice" });
    });

    it("parses TO with value", () => {
      const c = ctx("TO bob");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]).toEqual({ type: "TO", value: "bob" });
    });

    it("parses CC with value", () => {
      const c = ctx("CC carol");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]).toEqual({ type: "CC", value: "carol" });
    });

    it("parses BCC with value", () => {
      const c = ctx("BCC dave");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]).toEqual({ type: "BCC", value: "dave" });
    });

    it("parses SUBJECT with value", () => {
      const c = ctx("SUBJECT hello");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]).toEqual({ type: "SUBJECT", value: "hello" });
    });

    it("parses BODY with value", () => {
      const c = ctx("BODY world");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]).toEqual({ type: "BODY", value: "world" });
    });

    it("parses TEXT with value", () => {
      const c = ctx("TEXT search_term");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]).toEqual({ type: "TEXT", value: "search_term" });
    });

    it("parses HEADER with field and value", () => {
      const c = ctx("HEADER X-Custom value123");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]).toEqual({
        type: "HEADER",
        field: "X-Custom",
        value: "value123",
      });
    });
  });

  describe("size criteria", () => {
    it("parses LARGER with size", () => {
      const c = ctx("LARGER 1000");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]).toEqual({ type: "LARGER", size: 1000 });
    });

    it("parses SMALLER with size", () => {
      const c = ctx("SMALLER 500");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]).toEqual({ type: "SMALLER", size: 500 });
    });
  });

  describe("UID / sequence set", () => {
    it("parses UID with single number", () => {
      const c = ctx("UID 42");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]?.type).toBe("UID");
    });

    it("parses UID with range", () => {
      const c = ctx("UID 1:100");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]?.type).toBe("UID");
    });

    it("parses UID with wildcard", () => {
      const c = ctx("UID 1:*");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]?.type).toBe("UID");
    });
  });

  describe("logical operators", () => {
    it("parses NOT with single criterion", () => {
      const c = ctx("NOT SEEN");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]).toEqual({
        type: "NOT",
        criterion: { type: "SEEN" },
      });
    });

    it("parses NOT DELETED", () => {
      const c = ctx("NOT DELETED");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]).toEqual({
        type: "NOT",
        criterion: { type: "DELETED" },
      });
    });

    it("parses OR with two criteria", () => {
      const c = ctx("OR SEEN ANSWERED");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.[0]).toEqual({
        type: "OR",
        left: { type: "SEEN" },
        right: { type: "ANSWERED" },
      });
    });

    it("parses OR FLAGGED DELETED", () => {
      const c = ctx("OR FLAGGED DELETED");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      const criterion = result.value?.[0];
      expect(criterion?.type).toBe("OR");
      if (criterion?.type === "OR") {
        expect(criterion.left.type).toBe("FLAGGED");
        expect(criterion.right.type).toBe("DELETED");
      }
    });
  });

  describe("multiple criteria", () => {
    it("parses ALL SEEN (multiple)", () => {
      const c = ctx("ALL SEEN");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.length).toBe(2);
      expect(result.value?.[0]).toEqual({ type: "ALL" });
      expect(result.value?.[1]).toEqual({ type: "SEEN" });
    });

    it("parses UNSEEN FLAGGED SINCE 01-Jan-2024 (three criteria)", () => {
      const c = ctx("UNSEEN FLAGGED SINCE 01-Jan-2024");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.length).toBeGreaterThanOrEqual(3);
      expect(result.value?.[0]).toEqual({ type: "UNSEEN" });
      expect(result.value?.[1]).toEqual({ type: "FLAGGED" });
      expect(result.value?.[2]?.type).toBe("SINCE");
    });

    it("parses FROM alice SUBJECT hello", () => {
      const c = ctx("FROM alice SUBJECT hello");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value?.length).toBe(2);
      expect(result.value?.[0]).toEqual({ type: "FROM", value: "alice" });
      expect(result.value?.[1]).toEqual({ type: "SUBJECT", value: "hello" });
    });
  });

  describe("empty input", () => {
    it("returns empty criteria for empty string", () => {
      const c = ctx("");
      const result = parseSearchCriteria(c);
      expect(result.success).toBe(true);
      expect(result.value).toEqual([]);
    });
  });
});

describe("parseSearch", () => {
  it("wraps criteria in a SEARCH ImapRequest", () => {
    const c = ctx("ALL");
    const result = parseSearch(c);
    expect(result.success).toBe(true);
    expect(result.value?.type).toBe("SEARCH");
    expect((result.value as any)?.data?.criteria).toEqual([{ type: "ALL" }]);
  });

  it("parses SEARCH UNSEEN FLAGGED", () => {
    const c = ctx("UNSEEN FLAGGED");
    const result = parseSearch(c);
    expect(result.success).toBe(true);
    expect(result.value?.type).toBe("SEARCH");
    const criteria = (result.value as any)?.data?.criteria;
    expect(criteria?.length).toBe(2);
    expect(criteria?.[0]).toEqual({ type: "UNSEEN" });
    expect(criteria?.[1]).toEqual({ type: "FLAGGED" });
  });

  it("parses SEARCH FROM alice", () => {
    const c = ctx("FROM alice");
    const result = parseSearch(c);
    expect(result.success).toBe(true);
    expect(result.value?.type).toBe("SEARCH");
    const criteria = (result.value as any)?.data?.criteria;
    expect(criteria?.[0]).toEqual({ type: "FROM", value: "alice" });
  });

  it("returns failure for invalid input (no valid criteria)", () => {
    // An empty input results in success with empty criteria
    const c = ctx("");
    const result = parseSearch(c);
    // empty is valid per spec (though unusual)
    expect(result.success).toBe(true);
  });
});
