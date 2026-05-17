/**
 * Unit tests for `checkSpam` — verifies the classifier scoring gate
 * within the 4-layer spam pipeline.
 *
 * Uses dependency injection via `checkSpam(... , deps)` instead of
 * `mock.module`. The latter is process-wide in Bun and silently
 * replaced classifier.test.ts's imported `classifyEmail` with this
 * file's mock, causing the CD flake on 2026-05-17 (Hoie).
 */

import { describe, it, expect } from "bun:test";
import { checkSpam, CheckSpamDeps } from "./service";

const stubClassifier = (
  result: { score: number; reason: string | null },
): CheckSpamDeps["classifyEmail"] =>
  async () => result;

const stubAllowlist = (allowed: boolean): CheckSpamDeps["isAllowlisted"] =>
  async () => allowed;

const baseDeps = (score: number, reason: string | null): CheckSpamDeps => ({
  isAllowlisted: stubAllowlist(false),
  classifyEmail: stubClassifier({ score, reason }),
});

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
  it("ignores classifier score < 50 (HAM verdict) so it does not inflate totalScore", async () => {
    const result = await checkSpam("user1", subtleHamEmail, {}, baseDeps(49, null));
    // Rules contribute 20 (reply-to mismatch + html-only). Classifier verdict is HAM
    // (score 49 < 50, reason null) and must contribute 0 — pre-fix it added 49 → 69.
    expect(result.score).toBe(20);
    expect(result.isSpam).toBe(false);
    expect(result.flaggedBy).toBeUndefined();
  });

  it("adds classifier score >= 50 (SPAM verdict) to totalScore", async () => {
    const result = await checkSpam(
      "user1",
      subtleHamEmail,
      {},
      baseDeps(
        75,
        "Bayesian classifier: 75% spam probability (20 spam / 20 ham documents trained)",
      ),
    );
    // Rules 20 + classifier 75 = 95.
    expect(result.score).toBe(95);
    expect(result.isSpam).toBe(true);
    expect(result.reasons).toContain(
      "Bayesian classifier: 75% spam probability (20 spam / 20 ham documents trained)",
    );
  });

  it("adds classifier score = 50 (boundary SPAM verdict) to totalScore", async () => {
    const cleanEmail = {
      fromAddress: "x@y.com",
      subject: "Hello there",
      text: "Hi friend, hope you are well.",
    };
    const result = await checkSpam(
      "user1",
      cleanEmail,
      {},
      baseDeps(
        50,
        "Bayesian classifier: 50% spam probability (10 spam / 10 ham documents trained)",
      ),
    );
    expect(result.score).toBe(50);
    expect(result.isSpam).toBe(true);
    expect(result.flaggedBy).toBe("classifier");
  });

  it("treats classifier score = 0 as untrained (no contribution, no reason)", async () => {
    const result = await checkSpam("user1", subtleHamEmail, {}, baseDeps(0, null));
    expect(result.score).toBe(20);
    expect(result.isSpam).toBe(false);
  });

  it("does not set flaggedBy='classifier' when verdict is HAM", async () => {
    const result = await checkSpam(
      "user1",
      {
        fromAddress: "x@y.com",
        subject: "Hello there",
        text: "hello there",
      },
      {},
      baseDeps(30, null),
    );
    expect(result.flaggedBy).toBeUndefined();
  });
});
