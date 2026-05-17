/**
 * Unit tests for the Naive Bayes spam classifier.
 *
 * Uses dependency injection (positional `deps` arg on `trainWithEmail` /
 * `classifyEmail`) instead of `mock.module`, which is process-wide in
 * Bun and was the root cause of intermittent CI failures of the
 * "high score to spam-like email" case (Hoie 2026-05-17). Same DI
 * pattern as `backfill-snapshots.ts`.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

import { tokenize, extractTokens, trainWithEmail, classifyEmail } from "./classifier";

const mockTrainClassifier = mock(
  async (_userId: string, _words: string[], _isSpam: boolean): Promise<void> => {},
);
const mockGetClassifierDocCounts = mock(
  async (_userId: string): Promise<{ spamDocs: number; hamDocs: number }> => ({
    spamDocs: 0,
    hamDocs: 0,
  }),
);
const mockGetWordCounts = mock(
  async (
    _userId: string,
    _words: string[],
  ): Promise<Map<string, { spamCount: number; hamCount: number }>> => new Map(),
);

const trainDeps = { trainClassifier: mockTrainClassifier };
const classifyDeps = {
  getClassifierDocCounts: mockGetClassifierDocCounts,
  getWordCounts: mockGetWordCounts,
};

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
    // All 2-char words should be absent (min length is 3)
    expect(result.every((w) => w.length >= 3)).toBe(true);
    // "the" is 3 chars — should be included
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
    // Numbers alone should not appear
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
  beforeEach(() => {
    mockTrainClassifier.mockClear();
  });

  it("calls trainClassifier with extracted tokens", async () => {
    await trainWithEmail("user1", { subject: "Buy cheap meds", text: "Click here now" }, true, trainDeps);
    expect(mockTrainClassifier).toHaveBeenCalledTimes(1);
    const [userId, words, isSpam] = mockTrainClassifier.mock.calls[0] as [string, string[], boolean];
    expect(userId).toBe("user1");
    expect(isSpam).toBe(true);
    expect(words).toContain("cheap");
    expect(words).toContain("click");
  });

  it("skips training when no tokens can be extracted", async () => {
    await trainWithEmail("user1", {}, false, trainDeps);
    expect(mockTrainClassifier).not.toHaveBeenCalled();
  });

  it("trains as ham when isSpam=false", async () => {
    await trainWithEmail("user2", { subject: "Team standup tomorrow" }, false, trainDeps);
    const [, , isSpam] = mockTrainClassifier.mock.calls[0] as [string, string[], boolean];
    expect(isSpam).toBe(false);
  });
});

// --- classifyEmail() ---
describe("classifyEmail", () => {
  beforeEach(() => {
    mockGetClassifierDocCounts.mockClear();
    mockGetWordCounts.mockClear();
    // Reset to the default zero-docs implementation so prior tests'
    // `mockResolvedValueOnce` queues don't bleed across cases.
    mockGetClassifierDocCounts.mockImplementation(async () => ({ spamDocs: 0, hamDocs: 0 }));
    mockGetWordCounts.mockImplementation(async () => new Map());
  });

  it("returns score=0 when not enough training data (below MIN_TRAINING_DOCS=5)", async () => {
    mockGetClassifierDocCounts.mockResolvedValueOnce({ spamDocs: 2, hamDocs: 1 });
    const result = await classifyEmail("user1", { subject: "Win a prize" }, classifyDeps);
    expect(result.score).toBe(0);
    expect(result.reason).toBeNull();
  });

  it("returns score=0 when no spam docs trained", async () => {
    mockGetClassifierDocCounts.mockResolvedValueOnce({ spamDocs: 0, hamDocs: 10 });
    const result = await classifyEmail("user1", { subject: "Win a prize" }, classifyDeps);
    expect(result.score).toBe(0);
  });

  it("returns score=0 when no ham docs trained", async () => {
    mockGetClassifierDocCounts.mockResolvedValueOnce({ spamDocs: 10, hamDocs: 0 });
    const result = await classifyEmail("user1", { subject: "Hello team" }, classifyDeps);
    expect(result.score).toBe(0);
  });

  it("returns score=0 when email has no extractable tokens", async () => {
    mockGetClassifierDocCounts.mockResolvedValueOnce({ spamDocs: 10, hamDocs: 10 });
    const result = await classifyEmail("user1", {}, classifyDeps);
    expect(result.score).toBe(0);
  });

  it("assigns high score to spam-like email with sufficient training", async () => {
    mockGetClassifierDocCounts.mockResolvedValueOnce({ spamDocs: 20, hamDocs: 20 });
    // The word "win" seen 18/20 times in spam, 1/20 in ham → strongly spam
    mockGetWordCounts.mockResolvedValueOnce(
      new Map([
        ["win", { spamCount: 18, hamCount: 1 }],
        ["prize", { spamCount: 16, hamCount: 1 }],
        ["free", { spamCount: 15, hamCount: 1 }],
      ]),
    );
    const result = await classifyEmail(
      "user1",
      { subject: "Win a free prize today" },
      classifyDeps,
    );
    expect(result.score).toBeGreaterThan(50);
    expect(result.reason).not.toBeNull();
  });

  it("assigns low score to ham-like email with sufficient training", async () => {
    mockGetClassifierDocCounts.mockResolvedValueOnce({ spamDocs: 20, hamDocs: 20 });
    // Words only seen in ham
    mockGetWordCounts.mockResolvedValueOnce(
      new Map([
        ["standup", { spamCount: 0, hamCount: 15 }],
        ["meeting", { spamCount: 1, hamCount: 18 }],
        ["tomorrow", { spamCount: 0, hamCount: 17 }],
      ]),
    );
    const result = await classifyEmail(
      "user1",
      { subject: "Team standup meeting tomorrow" },
      classifyDeps,
    );
    expect(result.score).toBeLessThan(50);
    expect(result.reason).toBeNull();
  });

  it("returns score=0 and no error when DB throws", async () => {
    mockGetClassifierDocCounts.mockRejectedValueOnce(new Error("DB error"));
    const result = await classifyEmail("user1", { subject: "Hello there" }, classifyDeps);
    expect(result.score).toBe(0);
    expect(result.reason).toBeNull();
  });

  it("returns a score in [0, 100]", async () => {
    mockGetClassifierDocCounts.mockResolvedValueOnce({ spamDocs: 10, hamDocs: 10 });
    mockGetWordCounts.mockResolvedValueOnce(
      new Map([["click", { spamCount: 8, hamCount: 2 }]]),
    );
    const result = await classifyEmail("user1", { subject: "Click here" }, classifyDeps);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
