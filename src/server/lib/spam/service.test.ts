import { describe, it, expect, mock, beforeEach } from "bun:test";

const mockClassifyEmail = mock(async (_uid: string, _email: unknown) => ({
  score: 0,
  reason: null as string | null,
}));
const mockIsAllowlisted = mock(async (_uid: string, _addr: string) => false);

// Don't mock.module("./classifier", ...) — Bun's mock.module is process-wide
// and would clobber classifier.test.ts. Use the service's DI seam instead.
mock.module("../postgres/repositories/spam_allowlists", () => ({
  isAllowlisted: mockIsAllowlisted,
}));

const { checkSpam, setSpamServiceDependencies } = await import("./service");
setSpamServiceDependencies({ classifyEmail: mockClassifyEmail });

// Email crafted so two minor rules fire (reply-to-mismatch + html-only-no-text = 20 pts).
// remoteAddress is omitted so the DNSBL layer is skipped (no network calls in tests).
const subtleHamEmail = {
  fromAddress: "newsletter@company.com",
  replyToAddress: "marketing@othercompany.com",
  fromName: "Newsletter",
  subject: "Weekly newsletter",
  html: "<p>Read our weekly update. To unsubscribe click here.</p>",
};

describe("checkSpam — classifier scoring gate", () => {
  beforeEach(() => {
    mockClassifyEmail.mockClear();
    mockIsAllowlisted.mockClear();
  });

  it("ignores classifier score < 50 (HAM verdict) so it does not inflate totalScore", async () => {
    mockClassifyEmail.mockResolvedValueOnce({ score: 49, reason: null });
    const result = await checkSpam("user1", subtleHamEmail);
    // Rules contribute 20 (reply-to mismatch + html-only). Classifier verdict is HAM
    // (score 49 < 50, reason null) and must contribute 0 — pre-fix it added 49 → 69.
    expect(result.score).toBe(20);
    expect(result.isSpam).toBe(false);
    expect(result.flaggedBy).toBeUndefined();
  });

  it("adds classifier score >= 50 (SPAM verdict) to totalScore", async () => {
    mockClassifyEmail.mockResolvedValueOnce({
      score: 75,
      reason: "Bayesian classifier: 75% spam probability (20 spam / 20 ham documents trained)",
    });
    const result = await checkSpam("user1", subtleHamEmail);
    // Rules 20 + classifier 75 = 95.
    expect(result.score).toBe(95);
    expect(result.isSpam).toBe(true);
    expect(result.reasons).toContain(
      "Bayesian classifier: 75% spam probability (20 spam / 20 ham documents trained)"
    );
  });

  it("adds classifier score = 50 (boundary SPAM verdict) to totalScore", async () => {
    mockClassifyEmail.mockResolvedValueOnce({
      score: 50,
      reason: "Bayesian classifier: 50% spam probability (10 spam / 10 ham documents trained)",
    });
    const cleanEmail = {
      fromAddress: "x@y.com",
      subject: "Hello there",
      text: "Hi friend, hope you are well.",
    };
    const result = await checkSpam("user1", cleanEmail);
    expect(result.score).toBe(50);
    expect(result.isSpam).toBe(true);
    expect(result.flaggedBy).toBe("classifier");
  });

  it("treats classifier score = 0 as untrained (no contribution, no reason)", async () => {
    mockClassifyEmail.mockResolvedValueOnce({ score: 0, reason: null });
    const result = await checkSpam("user1", subtleHamEmail);
    expect(result.score).toBe(20);
    expect(result.isSpam).toBe(false);
  });

  it("does not set flaggedBy='classifier' when verdict is HAM", async () => {
    mockClassifyEmail.mockResolvedValueOnce({ score: 30, reason: null });
    const result = await checkSpam("user1", {
      fromAddress: "x@y.com",
      subject: "Hello there",
      text: "hello there",
    });
    expect(result.flaggedBy).toBeUndefined();
  });
});
