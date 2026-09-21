
import { describe, it, expect } from "bun:test";
import { checkSpam, CheckSpamDeps } from "./service";

const stubClassifier = (
  result: { score: number; reason: string | null },
): CheckSpamDeps["classifyEmail"] =>
  async () => result;

const stubAllowlist = (allowed: boolean): CheckSpamDeps["isAllowlisted"] =>
  async () => allowed;

const stubDnsbls = (
  score: number,
  reasons: string[] = [],
  evaluated = true,
): CheckSpamDeps["checkDnsbls"] =>
  async () => ({ score, listedIn: [], reasons, evaluated });

const baseDeps = (score: number, reason: string | null): CheckSpamDeps => ({
  isAllowlisted: stubAllowlist(false),
  classifyEmail: stubClassifier({ score, reason }),
});

const allowlistDeps = (
  overrides: Partial<CheckSpamDeps> = {},
): CheckSpamDeps => ({
  isAllowlisted: stubAllowlist(true),
  classifyEmail: stubClassifier({ score: 0, reason: null }),
  checkDnsbls: stubDnsbls(0),
  ...overrides,
});

// The allowlisted domain a forger claims. Body scores on the rule engine alone
// so the assertions never depend on the classifier or on a network lookup.
const spamFromAllowlistedDomain = {
  fromAddress: "spammer@ut-allow.example",
  fromName: "spammer@ut-allow.example",
  subject: "FREE MONEY WINNER ACT NOW!!!",
  text: "Click http://bit.ly/x to claim your free money prize winner. Act now!!!",
  html: "<p>Click <a href='http://bit.ly/x'>here</a> for your free money prize winner!!!</p>",
};

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

describe("checkSpam — allowlist exemption requires a corroborated sender", () => {
  it("exempts an allowlisted sender whose envelope sender shares its domain", async () => {
    const result = await checkSpam(
      "user1",
      {
        ...spamFromAllowlistedDomain,
        envelopeFromAddress: "bounce@ut-allow.example",
        remoteAddress: "198.51.100.7",
      },
      {},
      allowlistDeps(),
    );
    expect(result.score).toBe(0);
    expect(result.isSpam).toBe(false);
    expect(result.flaggedBy).toBe("allowlist");
    expect(result.reasons).toEqual(["Sender is allowlisted"]);
  });

  it("scores a forged From whose envelope sender is on another domain", async () => {
    const result = await checkSpam(
      "user1",
      {
        ...spamFromAllowlistedDomain,
        envelopeFromAddress: "envelope-sender@external.example",
      },
      {},
      allowlistDeps(),
    );
    expect(result.score).toBe(60);
    expect(result.isSpam).toBe(true);
    expect(result.flaggedBy).toBe("rules");
    expect(result.reasons).toContain("Allowlisted sender not confirmed by the envelope sender");
    expect(result.reasons).toContain("Subject >50% uppercase");
  });

  it("scores an allowlisted sender that arrived with no envelope sender", async () => {
    const result = await checkSpam("user1", spamFromAllowlistedDomain, {}, allowlistDeps());
    expect(result.score).toBe(60);
    expect(result.isSpam).toBe(true);
    expect(result.reasons).toContain("Allowlisted sender not confirmed by the envelope sender");
  });

  it("withdraws the exemption when the connecting address is blocklisted", async () => {
    const result = await checkSpam(
      "user1",
      {
        ...spamFromAllowlistedDomain,
        envelopeFromAddress: "bounce@ut-allow.example",
        remoteAddress: "198.51.100.7",
      },
      {},
      allowlistDeps({ checkDnsbls: stubDnsbls(40, ["Listed in Spamhaus ZEN"]) }),
    );
    expect(result.isSpam).toBe(true);
    expect(result.score).toBe(100);
    expect(result.reasons).toContain("Allowlisted sender arrived from a blocklisted address");
    expect(result.reasons).toContain("Listed in Spamhaus ZEN");
  });

  it("keeps the exemption for an aligned sender on a clean connecting address", async () => {
    const result = await checkSpam(
      "user1",
      {
        ...spamFromAllowlistedDomain,
        envelopeFromAddress: "bounce@ut-allow.example",
        remoteAddress: "198.51.100.7",
      },
      {},
      allowlistDeps({ checkDnsbls: stubDnsbls(0) }),
    );
    expect(result.score).toBe(0);
    expect(result.isSpam).toBe(false);
  });

  it("refuses the exemption when no blocklist could answer for the connecting address", async () => {
    const result = await checkSpam(
      "user1",
      {
        ...spamFromAllowlistedDomain,
        envelopeFromAddress: "bounce@ut-allow.example",
        remoteAddress: "2001:db8::1",
      },
      {},
      allowlistDeps({ checkDnsbls: stubDnsbls(0, [], false) }),
    );
    expect(result.score).toBe(60);
    expect(result.isSpam).toBe(true);
    expect(result.reasons).toContain(
      "Allowlisted sender arrived from an address no blocklist answered for",
    );
  });

  it("refuses the exemption when the mail carries no connecting address", async () => {
    const result = await checkSpam(
      "user1",
      { ...spamFromAllowlistedDomain, envelopeFromAddress: "bounce@ut-allow.example" },
      {},
      allowlistDeps(),
    );
    expect(result.score).toBe(60);
    expect(result.isSpam).toBe(true);
    expect(result.reasons).toContain(
      "Allowlisted sender arrived from an address no blocklist answered for",
    );
  });

  it("keeps the exemption when the blocklist layer is turned off by config", async () => {
    const result = await checkSpam(
      "user1",
      { ...spamFromAllowlistedDomain, envelopeFromAddress: "bounce@ut-allow.example" },
      { enableDnsbl: false },
      allowlistDeps(),
    );
    expect(result.score).toBe(0);
    expect(result.isSpam).toBe(false);
    expect(result.flaggedBy).toBe("allowlist");
  });

  it("still scores a blocklisted connection that is not allowlisted at all", async () => {
    const result = await checkSpam(
      "user1",
      {
        ...spamFromAllowlistedDomain,
        envelopeFromAddress: "bounce@ut-allow.example",
        remoteAddress: "198.51.100.7",
      },
      {},
      allowlistDeps({
        isAllowlisted: stubAllowlist(false),
        checkDnsbls: stubDnsbls(40, ["Listed in Spamhaus ZEN"]),
      }),
    );
    expect(result.score).toBe(100);
    expect(result.flaggedBy).toBe("dnsbl");
    expect(result.reasons).not.toContain("Allowlisted sender arrived from a blocklisted address");
  });
});
