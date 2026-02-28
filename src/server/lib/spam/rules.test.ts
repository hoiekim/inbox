import { describe, it, expect } from "bun:test";
import { evaluateRules } from "./rules";
import { EmailContext } from "./types";

describe("Spam Rules", () => {
  describe("missing-from rule", () => {
    it("should flag emails without from address", () => {
      const email: EmailContext = {
        subject: "Test",
        text: "Hello",
      };
      const result = evaluateRules(email);
      expect(result.matchedRules.some(r => r.id === "missing-from")).toBe(true);
    });

    it("should not flag emails with from address", () => {
      const email: EmailContext = {
        fromAddress: "test@example.com",
        subject: "Test",
        text: "Hello",
      };
      const result = evaluateRules(email);
      expect(result.matchedRules.some(r => r.id === "missing-from")).toBe(false);
    });
  });

  describe("reply-to-mismatch rule", () => {
    it("should flag emails where reply-to domain differs from from domain", () => {
      const email: EmailContext = {
        fromAddress: "sender@company.com",
        replyToAddress: "hidden@phishing.com",
        subject: "Test",
        text: "Hello",
      };
      const result = evaluateRules(email);
      expect(result.matchedRules.some(r => r.id === "reply-to-mismatch")).toBe(true);
    });

    it("should not flag emails where reply-to matches from domain", () => {
      const email: EmailContext = {
        fromAddress: "sender@company.com",
        replyToAddress: "support@company.com",
        subject: "Test",
        text: "Hello",
      };
      const result = evaluateRules(email);
      expect(result.matchedRules.some(r => r.id === "reply-to-mismatch")).toBe(false);
    });
  });

  describe("excessive-caps-subject rule", () => {
    it("should flag subjects with >50% uppercase", () => {
      const email: EmailContext = {
        fromAddress: "test@example.com",
        subject: "THIS IS ALL CAPS Message",
        text: "Hello",
      };
      const result = evaluateRules(email);
      expect(result.matchedRules.some(r => r.id === "excessive-caps-subject")).toBe(true);
    });

    it("should not flag normal subjects", () => {
      const email: EmailContext = {
        fromAddress: "test@example.com",
        subject: "This is a normal subject line",
        text: "Hello",
      };
      const result = evaluateRules(email);
      expect(result.matchedRules.some(r => r.id === "excessive-caps-subject")).toBe(false);
    });
  });

  describe("url-shortener rule", () => {
    it("should flag emails with bit.ly links", () => {
      const email: EmailContext = {
        fromAddress: "test@example.com",
        subject: "Check this out",
        text: "Click here: https://bit.ly/abc123",
      };
      const result = evaluateRules(email);
      expect(result.matchedRules.some(r => r.id === "url-shortener")).toBe(true);
    });

    it("should not flag normal URLs", () => {
      const email: EmailContext = {
        fromAddress: "test@example.com",
        subject: "Check this out",
        text: "Visit our website: https://example.com/page",
      };
      const result = evaluateRules(email);
      expect(result.matchedRules.some(r => r.id === "url-shortener")).toBe(false);
    });
  });

  describe("marketing-no-unsubscribe rule", () => {
    it("should flag marketing emails without unsubscribe", () => {
      const email: EmailContext = {
        fromAddress: "test@example.com",
        subject: "Special Offer",
        text: "Limited time offer! Buy now and save 50%! Act now before it's too late!",
      };
      const result = evaluateRules(email);
      expect(result.matchedRules.some(r => r.id === "marketing-no-unsubscribe")).toBe(true);
    });

    it("should not flag marketing emails with unsubscribe", () => {
      const email: EmailContext = {
        fromAddress: "test@example.com",
        subject: "Special Offer",
        text: "Limited time offer! Buy now and save 50%! Click here to unsubscribe.",
      };
      const result = evaluateRules(email);
      expect(result.matchedRules.some(r => r.id === "marketing-no-unsubscribe")).toBe(false);
    });
  });

  describe("suspicious-phrases rule", () => {
    it("should flag emails with lottery scam phrases", () => {
      const email: EmailContext = {
        fromAddress: "test@example.com",
        subject: "Winner Notification",
        text: "Congratulations you have won the lottery! Claim your prize now!",
      };
      const result = evaluateRules(email);
      expect(result.matchedRules.some(r => r.id === "suspicious-phrases")).toBe(true);
    });

    it("should not flag normal emails", () => {
      const email: EmailContext = {
        fromAddress: "test@example.com",
        subject: "Meeting Tomorrow",
        text: "Let's meet at 3pm to discuss the project.",
      };
      const result = evaluateRules(email);
      expect(result.matchedRules.some(r => r.id === "suspicious-phrases")).toBe(false);
    });
  });

  describe("score accumulation", () => {
    it("should accumulate scores from multiple rules", () => {
      const email: EmailContext = {
        // No from address (+20)
        subject: "URGENT!!!! YOU HAVE WON!!!!", // >50% caps (+10), 3+ exclamation (+10)
        text: "Click bit.ly/scam now! Congratulations you have won!", // URL shortener (+25), suspicious phrase (+15)
      };
      const result = evaluateRules(email);
      expect(result.score).toBeGreaterThanOrEqual(80);
      expect(result.matchedRules.length).toBeGreaterThan(3);
    });

    it("should return 0 score for clean emails", () => {
      const email: EmailContext = {
        fromAddress: "colleague@work.com",
        subject: "Quick question about the report",
        text: "Hi, can you send me the latest version of the quarterly report? Thanks!",
      };
      const result = evaluateRules(email);
      expect(result.score).toBe(0);
      expect(result.matchedRules.length).toBe(0);
    });
  });
});
