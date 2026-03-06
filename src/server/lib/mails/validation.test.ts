import { describe, it, expect } from "bun:test";
import { validateMailData, MailValidationError } from "./validation";

describe("validateMailData", () => {
  describe("sender validation", () => {
    it("should reject missing sender", () => {
      const result = validateMailData({
        sender: "",
        to: "test@example.com",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Sender is required");
    });

    it("should accept valid sender formats", () => {
      const validSenders = ["admin", "john.doe", "user-name", "user_name", "User123"];
      for (const sender of validSenders) {
        const result = validateMailData({
          sender,
          to: "test@example.com",
        });
        expect(result.valid).toBe(true);
      }
    });

    it("should reject invalid sender formats", () => {
      const invalidSenders = ["user@domain", "user name", "user<script>", ""];
      for (const sender of invalidSenders) {
        const result = validateMailData({
          sender,
          to: "test@example.com",
        });
        expect(result.valid).toBe(false);
      }
    });
  });

  describe("senderFullName validation (header injection)", () => {
    it("should reject sender name with CRLF (header injection attempt)", () => {
      const result = validateMailData({
        sender: "admin",
        senderFullName: "John\r\nBcc: attacker@evil.com",
        to: "test@example.com",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid sender name");
    });

    it("should reject sender name with newline", () => {
      const result = validateMailData({
        sender: "admin",
        senderFullName: "John\nX-Injected: header",
        to: "test@example.com",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid sender name");
    });

    it("should accept valid sender names", () => {
      const validNames = ["John Doe", "Jane Smith", "Company Name (Support)", "日本語名前"];
      for (const name of validNames) {
        const result = validateMailData({
          sender: "admin",
          senderFullName: name,
          to: "test@example.com",
        });
        expect(result.valid).toBe(true);
      }
    });
  });

  describe("recipient validation", () => {
    it("should reject missing recipient", () => {
      const result = validateMailData({
        sender: "admin",
        to: "",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Recipient email address is required");
    });

    it("should accept valid email addresses", () => {
      const validEmails = [
        "test@example.com",
        "user+tag@example.com",
        "user.name@sub.domain.com",
        "USER@EXAMPLE.COM",
      ];
      for (const email of validEmails) {
        const result = validateMailData({
          sender: "admin",
          to: email,
        });
        expect(result.valid).toBe(true);
      }
    });

    it("should accept multiple recipients", () => {
      const result = validateMailData({
        sender: "admin",
        to: "user1@example.com, user2@example.com",
      });
      expect(result.valid).toBe(true);
    });

    it("should reject invalid email in recipient list", () => {
      const result = validateMailData({
        sender: "admin",
        to: "valid@example.com, invalid-email, another@example.com",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid recipient address");
    });
  });

  describe("CC and BCC validation", () => {
    it("should accept valid CC addresses", () => {
      const result = validateMailData({
        sender: "admin",
        to: "test@example.com",
        cc: "cc1@example.com, cc2@example.com",
      });
      expect(result.valid).toBe(true);
    });

    it("should reject invalid CC addresses", () => {
      const result = validateMailData({
        sender: "admin",
        to: "test@example.com",
        cc: "invalid-cc",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid CC address");
    });

    it("should accept valid BCC addresses", () => {
      const result = validateMailData({
        sender: "admin",
        to: "test@example.com",
        bcc: "secret@example.com",
      });
      expect(result.valid).toBe(true);
    });

    it("should reject invalid BCC addresses", () => {
      const result = validateMailData({
        sender: "admin",
        to: "test@example.com",
        bcc: "not an email",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid BCC address");
    });
  });

  describe("length limits", () => {
    it("should reject subject exceeding 998 characters", () => {
      const longSubject = "x".repeat(999);
      const result = validateMailData({
        sender: "admin",
        to: "test@example.com",
        subject: longSubject,
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Subject exceeds maximum length");
    });

    it("should accept subject at exactly 998 characters", () => {
      const maxSubject = "x".repeat(998);
      const result = validateMailData({
        sender: "admin",
        to: "test@example.com",
        subject: maxSubject,
      });
      expect(result.valid).toBe(true);
    });

    it("should reject HTML body exceeding 10MB", () => {
      const largeHtml = "x".repeat(10 * 1024 * 1024 + 1);
      const result = validateMailData({
        sender: "admin",
        to: "test@example.com",
        html: largeHtml,
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("exceeds maximum size");
    });
  });

  describe("valid complete emails", () => {
    it("should accept a fully valid email with all fields", () => {
      const result = validateMailData({
        sender: "support",
        senderFullName: "Support Team",
        to: "customer@example.com",
        cc: "manager@example.com",
        bcc: "archive@example.com",
        subject: "Your Support Ticket #12345",
        html: "<html><body><p>Thank you for contacting us.</p></body></html>",
      });
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should accept minimal valid email", () => {
      const result = validateMailData({
        sender: "admin",
        to: "user@example.com",
      });
      expect(result.valid).toBe(true);
    });
  });
});

describe("MailValidationError", () => {
  it("should have correct name property", () => {
    const error = new MailValidationError("test error");
    expect(error.name).toBe("MailValidationError");
    expect(error.message).toBe("test error");
  });

  it("should be instance of Error", () => {
    const error = new MailValidationError("test");
    expect(error instanceof Error).toBe(true);
  });
});
