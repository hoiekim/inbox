/**
 * Unit tests for the Naive Bayes spam classifier.
 *
 * Uses dependency injection (positional `deps` arg on `trainWithEmail` /
 * `classifyEmail`) instead of `mock.module`, which is process-wide in
 * Bun and was the root cause of intermittent CI failures of the
 * "high score to spam-like email" case.
 *
 * Test stubs are plain async functions rather than `mock()` instances
 * + `mockResolvedValueOnce` queues — the queue-based pattern proved
 * flaky in CI (Bun 1.3.14 on ubuntu-latest) where the once-value did
 * not always survive across `beforeEach` mock resets. Plain functions
 * are simpler and deterministic.
 */

import { describe, it, expect } from "bun:test";

import { tokenize, extractTokens, trainWithEmail, classifyEmail } from "./classifier";

type DocCounts = { spamDocs: number; hamDocs: number };
type WordCounts = Map<string, { spamCount: number; hamCount: number }>;

const stubDocCounts = (counts: DocCounts) => async (_userId: string) => counts;
const stubWordCounts = (counts: WordCounts) => async (_u: string, _w: string[]) => counts;

// --- tokenize() ---
describe("tokenize", () => {
  it("lowercases and extracts words of 3+ letters", () => {
    const result = tokenize("Hello World foo");
    expect(result).toContain("hello");
    expect(result).toContain("world");
    expect(result).toContain("foo");
  });

  it("strips HTML tags before tokenizing", () => {
    const result = tokenize("<b>Click</b> here for <a href='x'>offers</a>");
    expect(result).toContain("click");
    expect(result).toContain("here");
    expect(result).toContain("offers");
    expect(result).not.toContain("href");
    expect(result).not.toContain("<b>");
  });

  it("filters out words shorter than 3 characters", () => {
    const result = tokenize("hi me it go the to");
    expect(result.every((w) => w.length >= 3)).toBe(true);
    expect(result).toContain("the");
  });

  it("deduplicates words", () => {
    const result = tokenize("spam spam spam");
    expect(result.filter((w) => w === "spam").length).toBe(1);
  });

  it("ignores numbers and punctuation", () => {
    const result = tokenize("Buy now! 50% off. Call 1-800-SPAM today.");
    expect(result).toContain("buy");
    expect(result).toContain("now");
    expect(result).toContain("off");
    expect(result).toContain("call");
    expect(result).toContain("spam");
    expect(result).toContain("today");
    expect(result).not.toContain("800");
    expect(result).not.toContain("50");
  });

  it("returns empty array for empty input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });

  it("caps output at MAX_WORDS_PER_DOCUMENT (500)", () => {
    const manyWords = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
    const result = tokenize(manyWords);
    expect(result.length).toBeLessThanOrEqual(500);
  });
});

// --- extractTokens() ---
describe("extractTokens", () => {
  it("combines subject, text, and html for tokenization", () => {
    const tokens = extractTokens({
      subject: "Win prizes",
      text: "Click here to claim your reward",
      html: "<p>Visit our <b>website</b></p>",
    });
    expect(tokens).toContain("win");
    expect(tokens).toContain("prizes");
    expect(tokens).toContain("click");
    expect(tokens).toContain("claim");
    expect(tokens).toContain("visit");
    expect(tokens).toContain("website");
  });

  it("works when only subject is present", () => {
    const tokens = extractTokens({ subject: "Hello there" });
    expect(tokens).toContain("hello");
    expect(tokens).toContain("there");
  });

  it("returns empty array when all fields are empty", () => {
    expect(extractTokens({})).toEqual([]);
  });
});

// --- trainWithEmail() ---
describe("trainWithEmail", () => {
  it("calls trainClassifier with extracted tokens", async () => {
    const calls: Array<[string, string[], boolean]> = [];
    const trainClassifier = async (userId: string, words: string[], isSpam: boolean) => {
      calls.push([userId, words, isSpam]);
    };

    await trainWithEmail(
      "user1",
      { subject: "Buy cheap meds", text: "Click here now" },
      true,
      { trainClassifier },
    );

    expect(calls.length).toBe(1);
    const [userId, words, isSpam] = calls[0];
    expect(userId).toBe("user1");
    expect(isSpam).toBe(true);
    expect(words).toContain("cheap");
    expect(words).toContain("click");
  });

  it("skips training when no tokens can be extracted", async () => {
    let called = false;
    const trainClassifier = async () => {
      called = true;
    };
    await trainWithEmail("user1", {}, false, { trainClassifier });
    expect(called).toBe(false);
  });

  it("trains as ham when isSpam=false", async () => {
    const calls: Array<[string, string[], boolean]> = [];
    const trainClassifier = async (u: string, w: string[], s: boolean) => {
      calls.push([u, w, s]);
    };
    await trainWithEmail("user2", { subject: "Team standup tomorrow" }, false, {
      trainClassifier,
    });
    expect(calls[0]?.[2]).toBe(false);
  });
});

// --- classifyEmail() ---
describe("classifyEmail", () => {
  it("returns score=0 when not enough training data (below MIN_TRAINING_DOCS=5)", async () => {
    const result = await classifyEmail(
      "user1",
      { subject: "Win a prize" },
      {
        getClassifierDocCounts: stubDocCounts({ spamDocs: 2, hamDocs: 1 }),
        getWordCounts: stubWordCounts(new Map()),
      },
    );
    expect(result.score).toBe(0);
    expect(result.reason).toBeNull();
  });

  it("returns score=0 when no spam docs trained", async () => {
    const result = await classifyEmail(
      "user1",
      { subject: "Win a prize" },
      {
        getClassifierDocCounts: stubDocCounts({ spamDocs: 0, hamDocs: 10 }),
        getWordCounts: stubWordCounts(new Map()),
      },
    );
    expect(result.score).toBe(0);
  });

  it("returns score=0 when no ham docs trained", async () => {
    const result = await classifyEmail(
      "user1",
      { subject: "Hello team" },
      {
        getClassifierDocCounts: stubDocCounts({ spamDocs: 10, hamDocs: 0 }),
        getWordCounts: stubWordCounts(new Map()),
      },
    );
    expect(result.score).toBe(0);
  });

  it("returns score=0 when email has no extractable tokens", async () => {
    const result = await classifyEmail(
      "user1",
      {},
      {
        getClassifierDocCounts: stubDocCounts({ spamDocs: 10, hamDocs: 10 }),
        getWordCounts: stubWordCounts(new Map()),
      },
    );
    expect(result.score).toBe(0);
  });

  it("assigns high score to spam-like email with sufficient training", async () => {
    const wordCounts: WordCounts = new Map([
      ["win", { spamCount: 18, hamCount: 1 }],
      ["prize", { spamCount: 16, hamCount: 1 }],
      ["free", { spamCount: 15, hamCount: 1 }],
    ]);
    const result = await classifyEmail(
      "user1",
      { subject: "Win a free prize today" },
      {
        getClassifierDocCounts: stubDocCounts({ spamDocs: 20, hamDocs: 20 }),
        getWordCounts: stubWordCounts(wordCounts),
      },
    );
    expect(result.score).toBeGreaterThan(50);
    expect(result.reason).not.toBeNull();
  });

  it("assigns low score to ham-like email with sufficient training", async () => {
    const wordCounts: WordCounts = new Map([
      ["standup", { spamCount: 0, hamCount: 15 }],
      ["meeting", { spamCount: 1, hamCount: 18 }],
      ["tomorrow", { spamCount: 0, hamCount: 17 }],
    ]);
    const result = await classifyEmail(
      "user1",
      { subject: "Team standup meeting tomorrow" },
      {
        getClassifierDocCounts: stubDocCounts({ spamDocs: 20, hamDocs: 20 }),
        getWordCounts: stubWordCounts(wordCounts),
      },
    );
    expect(result.score).toBeLessThan(50);
    expect(result.reason).toBeNull();
  });

  it("returns score=0 and no error when DB throws", async () => {
    const result = await classifyEmail(
      "user1",
      { subject: "Hello there" },
      {
        getClassifierDocCounts: async () => {
          throw new Error("DB error");
        },
        getWordCounts: stubWordCounts(new Map()),
      },
    );
    expect(result.score).toBe(0);
    expect(result.reason).toBeNull();
  });

  it("returns a score in [0, 100]", async () => {
    const result = await classifyEmail(
      "user1",
      { subject: "Click here" },
      {
        getClassifierDocCounts: stubDocCounts({ spamDocs: 10, hamDocs: 10 }),
        getWordCounts: stubWordCounts(new Map([["click", { spamCount: 8, hamCount: 2 }]])),
      },
    );
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
