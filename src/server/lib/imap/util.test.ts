import {
  encodeText,
  formatAddressList,
  formatHeaders,
  formatEnvelope,
  formatBodyStructure,
  formatFlags,
  accountToBox,
  boxToAccount,
  formatInternalDate
} from "./util";
import type { MailType, MailAddressValueType } from "common";

describe("IMAP util", () => {
  describe("encodeText", () => {
    it("should encode simple text to base64", () => {
      expect(encodeText("Hello")).toBe("SGVsbG8=");
    });

    it("should encode unicode text", () => {
      expect(encodeText("日本語")).toBe("5pel5pys6Kqe");
    });

    it("should encode empty string", () => {
      expect(encodeText("")).toBe("");
    });
  });

  describe("formatAddressList", () => {
    it("should return NIL for undefined value", () => {
      expect(formatAddressList(undefined)).toBe("NIL");
    });

    it("should return NIL for empty array", () => {
      expect(formatAddressList([])).toBe("NIL");
    });

    it("should format single address", () => {
      const addresses: MailAddressValueType[] = [
        { name: "John Doe", address: "john@example.com" }
      ];
      expect(formatAddressList(addresses)).toBe(
        '("John Doe" NIL "john" "example.com")'
      );
    });

    it("should format multiple addresses", () => {
      const addresses: MailAddressValueType[] = [
        { name: "John Doe", address: "john@example.com" },
        { name: "Jane Smith", address: "jane@example.com" }
      ];
      expect(formatAddressList(addresses)).toBe(
        '("John Doe" NIL "john" "example.com") ("Jane Smith" NIL "jane" "example.com")'
      );
    });

    it("should handle address with empty name", () => {
      const addresses: MailAddressValueType[] = [
        { name: "", address: "john@example.com" }
      ];
      expect(formatAddressList(addresses)).toBe('("" NIL "john" "example.com")');
    });

    it("should escape quotes in name", () => {
      const addresses: MailAddressValueType[] = [
        { name: 'John "Johnny" Doe', address: "john@example.com" }
      ];
      expect(formatAddressList(addresses)).toBe(
        '("John \\"Johnny\\" Doe" NIL "john" "example.com")'
      );
    });

    it("should skip invalid addresses without domain", () => {
      const addresses: MailAddressValueType[] = [
        { name: "Invalid", address: "nodomain" }
      ];
      expect(formatAddressList(addresses)).toBe("NIL");
    });

    it("should skip addresses with empty address field", () => {
      const addresses: MailAddressValueType[] = [{ name: "Empty", address: "" }];
      expect(formatAddressList(addresses)).toBe("NIL");
    });
  });

  describe("formatFlags", () => {
    it("should return empty array for unset flags", () => {
      const mail: Partial<MailType> = {};
      expect(formatFlags(mail)).toEqual([]);
    });

    it("should return \\Seen for read mail", () => {
      const mail: Partial<MailType> = { read: true };
      expect(formatFlags(mail)).toEqual(["\\Seen"]);
    });

    it("should return \\Flagged for saved mail", () => {
      const mail: Partial<MailType> = { saved: true };
      expect(formatFlags(mail)).toEqual(["\\Flagged"]);
    });

    it("should return \\Deleted for deleted mail", () => {
      const mail: Partial<MailType> = { deleted: true };
      expect(formatFlags(mail)).toEqual(["\\Deleted"]);
    });

    it("should return multiple flags", () => {
      const mail: Partial<MailType> = {
        read: true,
        saved: true,
        answered: true
      };
      expect(formatFlags(mail)).toEqual(["\\Seen", "\\Flagged", "\\Answered"]);
    });

    it("should return all flags when all are set", () => {
      const mail: Partial<MailType> = {
        read: true,
        saved: true,
        deleted: true,
        draft: true,
        answered: true
      };
      expect(formatFlags(mail)).toEqual([
        "\\Seen",
        "\\Flagged",
        "\\Deleted",
        "\\Draft",
        "\\Answered"
      ]);
    });
  });

  describe("accountToBox", () => {
    it("should extract local part from email under accounts/ folder", () => {
      expect(accountToBox("user@example.com")).toBe("INBOX/accounts/user");
    });

    it("should handle email with dots in local part", () => {
      expect(accountToBox("first.last@example.com")).toBe("INBOX/accounts/first.last");
    });

    it("should handle email with plus addressing", () => {
      expect(accountToBox("user+tag@example.com")).toBe("INBOX/accounts/user+tag");
    });
  });

  describe("boxToAccount", () => {
    // Note: This depends on getUserDomain which uses process.env.EMAIL_DOMAIN
    // The default is "mydomain", so for admin user it returns "mydomain"
    // For other users it returns "username.mydomain"

    it("should convert INBOX/accounts mailbox to account for admin", () => {
      const result = boxToAccount("admin", "INBOX/accounts/support");
      expect(result).toMatch(/support@/);
    });

    it("should convert Sent Messages mailbox to account", () => {
      const result = boxToAccount("testuser", "Sent Messages/accounts/support");
      expect(result).toMatch(/support@/);
    });

    it("should handle simple mailbox name", () => {
      const result = boxToAccount("testuser", "support");
      expect(result).toMatch(/support@/);
    });
  });

  describe("formatInternalDate", () => {
    it("should format date in IMAP internal date format", () => {
      // Use a fixed date to test format (avoiding timezone complications)
      const date = new Date("2024-01-15T10:30:45Z");
      const result = formatInternalDate(date);

      // Should match pattern: DD-Mon-YYYY HH:MM:SS +ZZZZ
      expect(result).toMatch(/^\d{2}-\w{3}-\d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/);
    });

    it("should space-pad single-digit day (RFC 3501 date-day-fixed)", () => {
      // Local-constructor form so the asserted day is timezone-invariant
      // (formatInternalDate reads local getDate()).
      const date = new Date(2024, 0, 5, 10, 30, 45);
      const result = formatInternalDate(date);
      expect(result).toMatch(/^ 5-Jan-/);
    });

    it("should render two-digit day without padding", () => {
      const date = new Date(2024, 0, 15, 10, 30, 45);
      const result = formatInternalDate(date);
      expect(result).toMatch(/^15-Jan-/);
    });

    it("should use correct month abbreviation", () => {
      const months = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec"
      ];
      months.forEach((month, index) => {
        const date = new Date(2024, index, 15, 10, 30, 45);
        const result = formatInternalDate(date);
        expect(result).toContain(`-${month}-`);
      });
    });
  });

  describe("formatEnvelope", () => {
    it("should format minimal envelope with NILs", () => {
      const mail: Partial<MailType> = {};
      const result = formatEnvelope(mail);
      expect(result).toContain("NIL NIL");
    });

    it("should include date when present", () => {
      const mail: Partial<MailType> = {
        date: "2024-01-15T10:30:00Z"
      };
      const result = formatEnvelope(mail);
      expect(result).toMatch(/^\(".*"\s/); // Starts with date in quotes
    });

    it("should include subject when present", () => {
      const mail: Partial<MailType> = {
        subject: "Test Subject"
      };
      const result = formatEnvelope(mail);
      expect(result).toContain('"Test Subject"');
    });

    it("should escape quotes in subject", () => {
      const mail: Partial<MailType> = {
        subject: 'Test "Quoted" Subject'
      };
      const result = formatEnvelope(mail);
      expect(result).toContain('Test \\"Quoted\\" Subject');
    });

    it("should include messageId when present", () => {
      const mail: Partial<MailType> = {
        messageId: "<test@example.com>"
      };
      const result = formatEnvelope(mail);
      expect(result).toContain('"<test@example.com>"');
    });

    it("should format from address", () => {
      const mail: Partial<MailType> = {
        from: {
          text: "John Doe <john@example.com>",
          value: [{ name: "John Doe", address: "john@example.com" }]
        }
      };
      const result = formatEnvelope(mail);
      expect(result).toContain('"John Doe" NIL "john" "example.com"');
    });

    it("emits absent address-list members as bare NIL, not (NIL) (RFC 3501 §7.4.2)", () => {
      // Empty mail: every one of the six address slots (from, sender,
      // reply-to, to, cc, bcc) must be the bare atom NIL. `(NIL)` matches
      // neither `nil` nor `"(" 1*address ")"` in the §9 grammar.
      const result = formatEnvelope({});
      expect(result).not.toContain("(NIL)");
      // date subject from sender reply-to to cc bcc in-reply-to message-id,
      // all absent → ten bare NILs wrapped in one outer paren.
      expect(result).toBe("(NIL NIL NIL NIL NIL NIL NIL NIL NIL NIL)");
    });

    it("keeps populated address slots parenthesized while absent ones stay bare NIL", () => {
      // Typical received mail: From + To present, no Cc/Bcc/Reply-To.
      const mail: Partial<MailType> = {
        from: {
          text: "John <john@example.com>",
          value: [{ name: "John", address: "john@example.com" }]
        },
        to: {
          text: "Jane <jane@example.com>",
          value: [{ name: "Jane", address: "jane@example.com" }]
        }
      };
      const result = formatEnvelope(mail);
      // Populated from/sender/to keep their single wrapping paren...
      expect(result).toContain('(("John" NIL "john" "example.com"))');
      expect(result).toContain('(("Jane" NIL "jane" "example.com"))');
      // ...and the absent reply-to/cc/bcc are bare NIL, not (NIL).
      expect(result).not.toContain("(NIL)");
    });
  });

  describe("formatHeaders", () => {
    it("should include MIME-Version header", () => {
      const mail: Partial<MailType> = {};
      const result = formatHeaders(mail);
      expect(result).toContain("MIME-Version: 1.0");
    });

    it("should include Message-ID when present", () => {
      const mail: Partial<MailType> = {
        messageId: "<test@example.com>"
      };
      const result = formatHeaders(mail);
      expect(result).toContain("Message-ID: <test@example.com>");
    });

    it("should include Subject when present", () => {
      const mail: Partial<MailType> = {
        subject: "Test Subject"
      };
      const result = formatHeaders(mail);
      expect(result).toContain("Subject: Test Subject");
    });

    it("should set text/plain Content-Type for text-only mail", () => {
      const mail: Partial<MailType> = {
        text: "Hello, World!"
      };
      const result = formatHeaders(mail);
      expect(result).toContain("Content-Type: text/plain; charset=utf-8");
    });

    it("should set text/html Content-Type for HTML-only mail", () => {
      const mail: Partial<MailType> = {
        html: "<p>Hello, World!</p>"
      };
      const result = formatHeaders(mail);
      expect(result).toContain("Content-Type: text/html; charset=utf-8");
    });

    it("should set multipart/alternative for text+HTML mail", () => {
      const mail: Partial<MailType> = {
        text: "Hello",
        html: "<p>Hello</p>"
      };
      const result = formatHeaders(mail, "test-doc-id");
      expect(result).toContain("multipart/alternative");
      expect(result).toContain('boundary="boundary_test-doc-id"');
    });

    it("should set multipart/mixed for mail with attachments", () => {
      const mail: Partial<MailType> = {
        text: "Hello",
        attachments: [
          { content: { data: "att1" }, filename: "test.txt", size: 100, contentType: "text/plain" }
        ]
      };
      const result = formatHeaders(mail, "test-doc-id");
      expect(result).toContain("multipart/mixed");
    });

    it("should use CRLF line endings", () => {
      const mail: Partial<MailType> = {
        subject: "Test",
        text: "Hello"
      };
      const result = formatHeaders(mail);
      expect(result).toContain("\r\n");
      expect(result).not.toMatch(/[^\r]\n/); // No bare LF
    });
  });

  describe("formatBodyStructure", () => {
    it("should format text-only body structure", () => {
      const mail: Partial<MailType> = {
        text: "Hello, World!"
      };
      const result = formatBodyStructure(mail);
      expect(result).toContain("TEXT");
      expect(result).toContain("PLAIN");
      expect(result).toContain("BASE64");
    });

    it("should format HTML-only body structure", () => {
      const mail: Partial<MailType> = {
        html: "<p>Hello, World!</p>"
      };
      const result = formatBodyStructure(mail);
      expect(result).toContain("TEXT");
      expect(result).toContain("HTML");
    });

    it("should format multipart/alternative for text+HTML", () => {
      const mail: Partial<MailType> = {
        text: "Hello",
        html: "<p>Hello</p>"
      };
      const result = formatBodyStructure(mail);
      expect(result).toContain('"alternative"');
    });

    it("should format multipart/mixed for attachments", () => {
      const mail: Partial<MailType> = {
        text: "Hello",
        attachments: [
          {
            content: { data: "att1" },
            filename: "test.pdf",
            size: 1024,
            contentType: "application/pdf"
          }
        ]
      };
      const result = formatBodyStructure(mail);
      expect(result).toContain('"mixed"');
      expect(result).toContain('"application"');
      expect(result).toContain('"pdf"');
    });

    it("should include attachment filename in disposition", () => {
      const mail: Partial<MailType> = {
        text: "Hello",
        attachments: [
          {
            content: { data: "att1" },
            filename: "document.pdf",
            size: 1024,
            contentType: "application/pdf"
          }
        ]
      };
      const result = formatBodyStructure(mail);
      expect(result).toContain('"ATTACHMENT"');
      expect(result).toContain('"FILENAME" "document.pdf"');
    });

    it("should default to empty text part", () => {
      const mail: Partial<MailType> = {};
      const result = formatBodyStructure(mail);
      expect(result).toContain("TEXT");
      expect(result).toContain("PLAIN");
    });

    // Non-extensible form (the bare `BODY` data item, RFC 3501 §6.4.5) drops the
    // extension data: md5/disposition/language/location on single parts and
    // param-list/disposition/language/location on the multipart wrappers (#666).
    describe("non-extensible form (extensible=false)", () => {
      it("leaves a leaf text part identical (it carries no extension data)", () => {
        const mail: Partial<MailType> = { text: "Hello, World!" };
        expect(formatBodyStructure(mail, false)).toBe(
          formatBodyStructure(mail, true)
        );
      });

      it("drops the multipart/alternative extension tail", () => {
        const mail: Partial<MailType> = { text: "Hello", html: "<p>Hello</p>" };
        const ext = formatBodyStructure(mail, true);
        const nonExt = formatBodyStructure(mail, false);
        expect(ext).toContain('"alternative" NIL NIL NIL NIL)');
        expect(nonExt).toContain('"alternative")');
        expect(nonExt).not.toContain('"alternative" NIL');
      });

      it("drops md5/disposition/language/location from an attachment part and the mixed tail", () => {
        const mail: Partial<MailType> = {
          text: "Hello",
          attachments: [
            {
              content: { data: "att1" },
              filename: "document.pdf",
              size: 1024,
              contentType: "application/pdf"
            }
          ]
        };
        const ext = formatBodyStructure(mail, true);
        const nonExt = formatBodyStructure(mail, false);
        // Extension data present in BODYSTRUCTURE, absent in the bare BODY form.
        expect(ext).toContain('"ATTACHMENT"');
        expect(ext).toContain('"mixed" NIL NIL NIL NIL)');
        expect(nonExt).not.toContain('"ATTACHMENT"');
        expect(nonExt).toContain('"mixed")');
        expect(nonExt).not.toContain('"mixed" NIL');
        // The attachment part itself now ends at the size field (BASE64 <size>).
        const attachmentSize = Math.ceil(1024 / 3) * 4;
        expect(nonExt).toContain(`"application" "pdf"`);
        expect(nonExt).toContain(`BASE64 ${attachmentSize})`);
      });
    });
  });
});
