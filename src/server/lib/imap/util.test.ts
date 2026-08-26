import {
  attachmentPartHeaderFields,
  boundaryToken,
  encodeText,
  formatAddressList,
  formatHeaders,
  headerFieldValue,
  headerQuotedParam,
  formatEnvelope,
  formatBodyStructure,
  formatFlags,
  accountToBox,
  boxToAccount,
  formatInternalDate,
  isDomainScoped,
  deriveCopyMessageId,
  quoteString,
  formatNString,
} from "./util";
// The producer of the bytes `BODY[n]` serves. `body-fld-lines` is a constant
// here only because that encoding is unfolded, so the invariant is pinned
// against it rather than against this file's own encoder.
import {
  buildMessageSegments,
  streamPartBodyFromSegments,
} from "./session-utils";
import type {
  MailType,
  MailAddressValueType,
  AttachmentType,
} from "common";

describe("IMAP util", () => {
  describe("isDomainScoped", () => {
    it("is true for INBOX in any casing", () => {
      expect(isDomainScoped("INBOX")).toBe(true);
      expect(isDomainScoped("inbox")).toBe(true);
      expect(isDomainScoped("Inbox")).toBe(true);
    });

    it("is true for the unified Sent Messages folder", () => {
      expect(isDomainScoped("Sent Messages")).toBe(true);
    });

    it("is false for account-scoped and user mailboxes", () => {
      expect(isDomainScoped("Sent Messages/accounts/foo")).toBe(false);
      expect(isDomainScoped("INBOX/accounts/foo")).toBe(false);
      expect(isDomainScoped("Archive")).toBe(false);
      expect(isDomainScoped("")).toBe(false);
    });
  });

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

    it("should emit NIL as addr-name for an empty name", () => {
      const addresses: MailAddressValueType[] = [
        { name: "", address: "john@example.com" }
      ];
      expect(formatAddressList(addresses)).toBe(
        '(NIL NIL "john" "example.com")'
      );
    });

    it("should emit NIL as addr-name for an absent name", () => {
      const addresses: MailAddressValueType[] = [
        { address: "john@example.com" }
      ];
      expect(formatAddressList(addresses)).toBe(
        '(NIL NIL "john" "example.com")'
      );
    });

    it("should not quote a whitespace-only name away — it is a present name", () => {
      const addresses: MailAddressValueType[] = [
        { name: " ", address: "john@example.com" }
      ];
      expect(formatAddressList(addresses)).toBe(
        '(" " NIL "john" "example.com")'
      );
    });

    it("should mix NIL and quoted addr-names within one list", () => {
      const addresses: MailAddressValueType[] = [
        { name: "", address: "john@example.com" },
        { name: "Jane Smith", address: "jane@example.com" }
      ];
      expect(formatAddressList(addresses)).toBe(
        '(NIL NIL "john" "example.com") ("Jane Smith" NIL "jane" "example.com")'
      );
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

    it("emits a no-display-name address as NIL addr-name inside a present address", () => {
      // A bare `From: sender@example.com` / `To: recipient@example.com`. The
      // address structure is present, so it stays parenthesized, but each
      // addr-name is the bare atom NIL.
      const mail: Partial<MailType> = {
        from: {
          text: "sender@example.com",
          value: [{ name: "", address: "sender@example.com" }]
        },
        to: {
          text: "recipient@example.com",
          value: [{ name: "", address: "recipient@example.com" }]
        }
      };
      const result = formatEnvelope(mail);
      expect(result).toContain('((NIL NIL "sender" "example.com"))');
      expect(result).toContain('((NIL NIL "recipient" "example.com"))');
      expect(result).not.toContain('""');
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

  describe("formatHeaders — header injection (#826)", () => {
    /** The block's field names, in order, one entry per emitted line. */
    const fieldsOf = (block: string): string[] =>
      block.split("\r\n").map((line) => line.slice(0, line.indexOf(":")));

    const HOSTILE = "Hello\r\nFrom: ceo@bank.example\r\nX-Evil: 1";

    it("a CRLF-bearing subject emits one Subject line and no new field", () => {
      const block = formatHeaders(
        {
          messageId: "<x@y>",
          from: { text: "real@sender.example", value: [] } as MailType["from"],
          subject: HOSTILE,
          text: "body"
        },
        "doc1"
      );

      expect(fieldsOf(block)).toEqual([
        "Message-ID",
        "From",
        "Subject",
        "MIME-Version",
        "Content-Type",
        "Content-Transfer-Encoding"
      ]);
      expect(block).toContain("Subject: Hello From: ceo@bank.example X-Evil: 1");
      expect(block).toContain("From: real@sender.example\r\n");
    });

    const CARRIERS = [
      ["messageId", (v: string) => ({ messageId: v })],
      ["subject", (v: string) => ({ subject: v })],
      ["from", (v: string) => ({ from: { text: v, value: [] } })],
      ["to", (v: string) => ({ to: { text: v, value: [] } })],
      ["cc", (v: string) => ({ cc: { text: v, value: [] } })],
      ["bcc", (v: string) => ({ bcc: { text: v, value: [] } })],
      ["replyTo", (v: string) => ({ replyTo: { text: v, value: [] } })]
    ] as const;

    it("no stored field can open a header line", () => {
      const injected = CARRIERS.map(([name, build]) => {
        const block = formatHeaders(
          build(HOSTILE) as Partial<MailType>,
          "doc1"
        );
        // The payload survives as text inside its own field — what must not
        // happen is a LINE of it, which is what the client selects on.
        const opened = block
          .split("\r\n")
          .some((line) => line.startsWith("From: ceo@bank.example"));
        return [name, opened] as const;
      });

      expect(injected).toEqual(
        CARRIERS.map(([name]) => [name, false] as const)
      );
    });

    it("no stored field can terminate the header block early", () => {
      // CRLF CRLF is the RFC 5322 §2.1 body delimiter — a value carrying it
      // would push its own tail out of the header block and into the body,
      // which `BODY[TEXT]` then serves as message content.
      const split = CARRIERS.map(([name, build]) => {
        const block = formatHeaders(
          build("start\r\n\r\nbody-goes-here") as Partial<MailType>,
          "doc1"
        );
        return [name, block.includes("\r\n\r\n")] as const;
      });

      expect(split).toEqual(CARRIERS.map(([name]) => [name, false] as const));
    });

    it("a hostile Message-ID cannot escape the multipart boundary", () => {
      // No docId → the boundary falls back to the stored Message-ID, so the
      // sender's bytes land inside `boundary="…"` and in every `--<boundary>`
      // delimiter downstream.
      const block = formatHeaders({
        messageId: '<a@b>\r\nX-Evil: 1"',
        text: "hi",
        html: "<p>hi</p>"
      });
      const boundary = block.match(/boundary="([^"\r\n]*)"/)?.[1];

      expect(boundary).toBe("boundary__a_b___X-Evil__1_");
      expect(fieldsOf(block)).toEqual([
        "Message-ID",
        "MIME-Version",
        "Content-Type"
      ]);
    });
  });

  describe("headerFieldValue", () => {
    it("collapses each CR / LF / NUL run to a single space", () => {
      expect(headerFieldValue("a\r\nb\nc\rd\0e")).toBe("a b c d e");
    });

    it("collapses U+2028 / U+2029 — line starts for a `/m` JS regex", () => {
      // Not RFC 5322 line breaks, but ECMAScript `LineTerminator`s: left in,
      // `rewriteContentType`'s `/^Content-Type: …/m` matches inside the value.
      expect(headerFieldValue("a\u2028b\u2029c")).toBe("a b c");
    });

    it("leaves a value with no line breaks byte-identical", () => {
      expect(headerFieldValue('Re: "quoted" \\ subject')).toBe(
        'Re: "quoted" \\ subject'
      );
    });
  });

  describe("headerQuotedParam", () => {
    it("escapes the quote that would close the parameter early", () => {
      // Unescaped, `evil.txt"; filename="wanted.pdf` renames the attachment.
      expect(headerQuotedParam('evil.txt"; filename="wanted.pdf')).toBe(
        '"evil.txt\\"; filename=\\"wanted.pdf"'
      );
    });

    it("escapes a trailing backslash so the string still terminates", () => {
      expect(headerQuotedParam("report\\")).toBe('"report\\\\"');
    });

    it("strips line breaks before quoting", () => {
      expect(headerQuotedParam("a\r\nb")).toBe('"a b"');
    });
  });

  describe("boundaryToken", () => {
    it("passes through the RFC 2046 bcharsnospace subset unchanged", () => {
      expect(boundaryToken("test-doc.id_1")).toBe("test-doc.id_1");
    });

    it("substitutes character-for-character, so the length is stable", () => {
      const hostile = '<a@b>\r\n"';
      expect(boundaryToken(hostile)).toBe("_a_b____");
      expect(boundaryToken(hostile).length).toBe(hostile.length);
    });
  });

  describe("formatBodyStructure", () => {
    // RFC 3501 §9: media-type + media-subtype + body-fld-enc are `string`
    // (quoted or literal). Bare atoms crash strict client parsers (Apple Mail
    // iOS ≥ 26 aborts and retry-loops); assertions below pin the QUOTED form
    // byte-for-byte so a regression to the bare-atom shape fails the suite.
    it("quotes TEXT/PLAIN and BASE64 per RFC 3501 §9 (text-only)", () => {
      const mail: Partial<MailType> = { text: "Hello, World!" };
      const result = formatBodyStructure(mail);
      // The byte-perfect pin below carries the full-shape regression; here
      // just assert the three tokens land in their quoted form so a partial
      // regression on any one is caught in isolation.
      expect(result).toContain('"TEXT"');
      expect(result).toContain('"PLAIN"');
      expect(result).toContain('"BASE64"');
    });

    it("advertises zero lines for a zero-octet part, the only honest count when BODY[n] has nothing to serve", () => {
      // A mail with no text/html falls back to an empty TEXT PLAIN part.
      // buildMessageSegments emits no body segment for it, and a BODY[1]
      // fetch declines the data item outright rather than serving an empty
      // literal — so claiming one line describes a line nobody receives.
      const empty = formatBodyStructure({}, true);
      const nonEmpty = formatBodyStructure({ text: "hi" }, true);
      expect([
        empty.includes(' "BASE64" 0 0 '),
        nonEmpty.includes(' "BASE64" 4 1 ')
      ]).toEqual([true, true]);
    });

    it("quotes TEXT/HTML per RFC 3501 §9 (html-only)", () => {
      const mail: Partial<MailType> = { html: "<p>Hello, World!</p>" };
      const result = formatBodyStructure(mail);
      expect(result).toContain('"TEXT"');
      expect(result).toContain('"HTML"');
    });

    it("emits multipart/alternative with NO space between sibling parts (RFC 3501 §9)", () => {
      const mail: Partial<MailType> = {
        text: "Hello",
        html: "<p>Hello</p>"
      };
      const result = formatBodyStructure(mail);
      expect(result).toContain('"alternative"');
      // ABNF: body-type-mpart = 1*body SP media-subtype — siblings concatenate
      // with no separator; the single SP is the sentinel before media-subtype.
      // Correct: `)(` between siblings, ` "alternative"` before subtype.
      expect(result).toMatch(/\)\("TEXT" "HTML"/);
      expect(result).not.toMatch(/\) \("TEXT" "HTML"/);
    });

    it("emits multipart/mixed with NO space between sibling parts", () => {
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
      // Text part → attachment part concatenate with no space.
      expect(result).toMatch(/\)\("application"/);
      expect(result).not.toMatch(/\) \("application"/);
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

    it("should default to empty text part with quoted TEXT/PLAIN", () => {
      const mail: Partial<MailType> = {};
      const result = formatBodyStructure(mail);
      expect(result).toContain('"TEXT"');
      expect(result).toContain('"PLAIN"');
    });

    // Byte-for-byte pin — regression against the exact prod shape that
    // Apple Mail iOS 26 stuck on. Covers all three violations at once:
    // (a) quoted TEXT/PLAIN/HTML, (b) quoted BASE64, (c) no space between
    // sibling parts inside the outer multipart wrapper. The persisted
    // decoded line counts are projected on purpose: they must not reach the
    // wire, where body-fld-lines counts the transfer-encoded body instead.
    it("full byte-perfect shape for text+html+2 attachments (the iOS regression case)", () => {
      const mail: Partial<MailType> = {
        text_octets: 27060,
        html_octets: 11138020,
        text_line_count: 522,
        html_line_count: 230,
        attachments: [
          {
            content: { data: "att1" },
            filename: "1000025304.jpg",
            size: 6162016,
            contentType: "image/jpeg"
          },
          {
            content: { data: "att2" },
            filename: "1000025344.jpg",
            size: 81495,
            contentType: "image/jpeg"
          }
        ]
      };
      const expected =
        '((' +
          '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "BASE64" 36080 1 NIL NIL NIL NIL)' +
          '("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "BASE64" 14850696 1 NIL NIL NIL NIL)' +
          ' "alternative" NIL NIL NIL NIL' +
        ')' +
        '("image" "jpeg" ("NAME" "1000025304.jpg") NIL NIL "BASE64" 8216024 NIL ("ATTACHMENT" ("FILENAME" "1000025304.jpg")) NIL NIL)' +
        '("image" "jpeg" ("NAME" "1000025344.jpg") NIL NIL "BASE64" 108660 NIL ("ATTACHMENT" ("FILENAME" "1000025344.jpg")) NIL NIL)' +
        ' "mixed" NIL NIL NIL NIL)';
      expect(formatBodyStructure(mail)).toBe(expected);
    });

    // #740: BODYSTRUCTURE's `size` derives from the persisted octet column
    // when the caller projects it (the BODYSTRUCTURE hot path — no text/html
    // string materialization). The wire response for the same underlying
    // content must be byte-identical whether we take the cached path or fall
    // through to base64-and-measure.
    it("derives text-part size from the cached octets with no strings loaded", () => {
      const cached = formatBodyStructure({
        text_octets: 30,
        html_octets: 0
      });
      // ceil(30/3)*4 = 40 octets base64, served as one unfolded base64 line.
      expect(cached).toContain('"BASE64" 40 1');
      // No HTML → single text part, not multipart.
      expect(cached).not.toContain("alternative");
    });

    it("cached-shape output matches materialized-shape output for the same content", () => {
      const text = "line one\r\nline two\r\nline three";
      const materialized = formatBodyStructure({ text });
      const cached = formatBodyStructure({
        text_octets: Buffer.byteLength(text, "utf8"),
        html_octets: 0
      });
      expect(cached).toBe(materialized);
    });

    // RFC 3501 §7.4.2 — body-fld-octets and body-fld-lines must describe the
    // same (transfer-encoded) representation of the part.
    describe("body-fld-lines describes the transfer-encoded body", () => {
      it("reports the encoded line count, not the decoded one", () => {
        const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join(
          "\n"
        );
        const encoded = encodeText(text);
        const result = formatBodyStructure({ text }, false);
        // 40 decoded lines, but one unfolded base64 line is what is served.
        expect(result).toBe(
          `("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "BASE64" ${encoded.length} 1)`
        );
      });

      it("counts lines over the same bytes body-fld-octets measures", () => {
        // The body has to clear the 76-column fold threshold RFC 2045 §6.8
        // describes (>57 raw bytes), or `encoded.split(...)` is 1 whatever
        // the encoder does and the derived expectation asserts nothing.
        const html = Array.from({ length: 12 }, (_, i) => `<p>row ${i}</p>`).join("\r\n");
        expect(Buffer.byteLength(html, "utf8")).toBeGreaterThan(57);
        const encoded = encodeText(html);
        const result = formatBodyStructure({ html }, false);
        const [, size, lines] = result.match(/"BASE64" (\d+) (\d+)\)$/)!;
        expect(Number(size)).toBe(Buffer.byteLength(encoded, "utf-8"));
        expect(Number(lines)).toBe(encoded.split(/\r?\n/).length);
      });

      it("reports zero octets and zero lines on the empty default part", () => {
        // buildMessageSegments emits no body segment for a mail with no
        // text/html, and a BODY[1] fetch omits the data item rather than
        // serving an empty literal — both counts must say so.
        expect(formatBodyStructure({}, false)).toBe(
          `("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "BASE64" 0 0)`
        );
      });
    });

    // `lines` is a constant, and the only thing that makes the constant true
    // is that the base64 the server serves is unfolded. That encoding does
    // NOT live in this file — `streamPartBodyFromSegments` emits the bytes
    // `BODY[n]` returns, and it re-implements the encoder rather than
    // importing `encodeText`. So the invariant is pinned against the real
    // producer: fold the body at 76 columns per RFC 2045 §6.8 and
    // `body-fld-lines 1` starts describing a representation nobody receives.
    describe("the unfolded-base64 invariant the line count rests on", () => {
      // Well past the 76-column wrap point, so a folding encoder cannot
      // slip through on a body too short to wrap.
      const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\r\n");

      const servedBody = async (
        mail: Partial<MailType>,
        partPath: string
      ): Promise<string> => {
        const chunks: Buffer[] = [];
        const segments = buildMessageSegments(mail as MailType, "docId");
        for await (const chunk of streamPartBodyFromSegments(segments, partPath)) {
          chunks.push(chunk);
        }
        return Buffer.concat(chunks as unknown as Uint8Array[]).toString("utf8");
      };

      it("the bytes BODY[n] actually serves carry no line break", async () => {
        const served = await servedBody({ text }, "1");
        expect(Buffer.byteLength(served, "utf8")).toBeGreaterThan(76);
        expect(served).not.toContain("\n");
        expect(served).not.toContain("\r");
      });

      it("the served bytes are one line, which is what BODYSTRUCTURE advertises", async () => {
        const served = await servedBody({ text }, "1");
        const advertised = formatBodyStructure({ text }, false).match(
          /"BASE64" (\d+) (\d+)\)$/
        )!;
        expect(Number(advertised[1])).toBe(Buffer.byteLength(served, "utf8"));
        expect(Number(advertised[2])).toBe(served.split(/\r?\n/).length);
      });

      it("the measuring encoder agrees with the serving one", async () => {
        // `formatBodyStructure` sizes the materialized path with `encodeText`
        // while the wire body comes from the segment stream. Two encoders,
        // one invariant — they have to stay byte-identical.
        expect(encodeText(text)).toBe(await servedBody({ text }, "1"));
      });
    });

    // RFC 3501 §7.4.2 — `body-type-1part = body-type-text [SP body-ext-1part]`,
    // where body-ext-1part is md5/disposition/language/location. Present in
    // BODYSTRUCTURE, absent from the bare `BODY` data item (§6.4.5).
    describe("body-ext-1part tail on text parts", () => {
      it("is emitted on a leaf text part and dropped from the bare BODY form", () => {
        const mail: Partial<MailType> = { text: "Hello, World!" };
        const encoded = encodeText("Hello, World!");
        const head = `("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "BASE64" ${encoded.length} 1`;
        expect(formatBodyStructure(mail, true)).toBe(`${head} NIL NIL NIL NIL)`);
        expect(formatBodyStructure(mail, false)).toBe(`${head})`);
      });

      it("is emitted on text parts nested in a multipart", () => {
        const mail: Partial<MailType> = { text: "Hello", html: "<p>Hello</p>" };
        const ext = formatBodyStructure(mail, true);
        const nonExt = formatBodyStructure(mail, false);
        expect(ext.match(/NIL NIL NIL NIL\)/g)).toHaveLength(3); // 2 text parts + the multipart tail
        expect(nonExt).not.toContain("NIL NIL NIL NIL");
      });
    });

    // RFC 3501 §9 — `body-type-text = media-text SP body-fields SP
    // body-fld-lines`. An attachment whose media type is `text` takes the
    // text grammar, not body-type-basic, so it carries the line count the
    // inline text parts carry.
    describe("body-fld-lines on text/* attachments", () => {
      const withAttachment = (
        contentType: string,
        size: number
      ): Partial<MailType> => ({
        text: "Hello",
        attachments: [
          { content: { data: "att" }, filename: "notes.txt", size, contentType }
        ]
      });

      it("emits the line count on a text/plain attachment and omits it on a binary one", () => {
        const textPart = formatBodyStructure(withAttachment("text/plain", 100), false);
        const binaryPart = formatBodyStructure(
          withAttachment("application/pdf", 100),
          false
        );
        const size = Math.ceil(100 / 3) * 4;
        expect(textPart).toContain(
          `("text" "plain" ("NAME" "notes.txt") NIL NIL "BASE64" ${size} 1)`
        );
        expect(binaryPart).toContain(
          `("application" "pdf" ("NAME" "notes.txt") NIL NIL "BASE64" ${size})`
        );
      });

      it("keeps the line count ahead of the body-ext-1part tail", () => {
        const size = Math.ceil(100 / 3) * 4;
        expect(formatBodyStructure(withAttachment("TEXT/PLAIN", 100), true)).toContain(
          `"BASE64" ${size} 1 NIL ("ATTACHMENT" ("FILENAME" "notes.txt")) NIL NIL)`
        );
      });

      it("advertises zero lines for a zero-octet text attachment", () => {
        expect(formatBodyStructure(withAttachment("text/plain", 0), false)).toContain(
          `"BASE64" 0 0)`
        );
      });
    });

    // Non-extensible form (the bare `BODY` data item, RFC 3501 §6.4.5) drops the
    // extension data: md5/disposition/language/location on single parts and
    // param-list/disposition/language/location on the multipart wrappers (#666).
    describe("non-extensible form (extensible=false)", () => {
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
        expect(nonExt).toContain(`"BASE64" ${attachmentSize})`);
      });
    });
  });

  describe("deriveCopyMessageId — retry idempotency (#721)", () => {
    it("returns the same id for the same (source, dest) — the load-bearing invariant", () => {
      const a = deriveCopyMessageId("src-msg-id", "INBOX/accounts/foo");
      const b = deriveCopyMessageId("src-msg-id", "INBOX/accounts/foo");
      expect(a).toBe(b);
    });

    it("returns different ids for different source Message-IDs", () => {
      const a = deriveCopyMessageId("src-msg-id-A", "INBOX/accounts/foo");
      const b = deriveCopyMessageId("src-msg-id-B", "INBOX/accounts/foo");
      expect(a).not.toBe(b);
    });

    it("returns different ids for different destination mailboxes", () => {
      // Same source, different dest → different id. Otherwise COPYing the
      // same source to two different mailboxes would produce a single
      // shared destination row (via 23505 merge) instead of two.
      const a = deriveCopyMessageId("src-msg-id", "INBOX/accounts/foo");
      const b = deriveCopyMessageId("src-msg-id", "Archive");
      expect(a).not.toBe(b);
    });

    it("uses a separator that prevents source/dest boundary confusion", () => {
      // Without the `\0` separator, ("srcId", "dest") and ("srcIddest", "")
      // would hash to the same string. The separator prevents this.
      const a = deriveCopyMessageId("src", "dest");
      const b = deriveCopyMessageId("srcdest", "");
      expect(a).not.toBe(b);
    });

    it("falls back to random for missing source Message-ID so undefined sources don't collide", () => {
      // mails.message_id is NOT NULL in prod, but defensively: two rows
      // with undefined source ids must NOT hash to the same derived id
      // (they'd merge into a single dest row via 23505 → wrong count).
      const a = deriveCopyMessageId(undefined, "INBOX/accounts/foo");
      const b = deriveCopyMessageId(undefined, "INBOX/accounts/foo");
      expect(a).not.toBe(b);
    });

    it("emits a valid RFC-shaped Message-ID (angle-bracket-free, has `@`)", () => {
      // saveMail's DB layer wraps in `<>` when needed; the raw form here
      // is `<hash>.copy@server` — a compact deterministic derivation the
      // server treats as its own storage id, not a re-delivered RFC 5322
      // message-id (RFC 3501 §6.4.7 permits this).
      const id = deriveCopyMessageId("src", "dest");
      expect(id).toMatch(/^[a-f0-9]{16}\.copy@server$/);
    });
  });

  // Mis-escaped backslashes and raw CR/LF are both desync bugs, not rendering
  // bugs: either one makes the CLIENT's parser lose the string boundary and
  // mis-frame every later token on the line. So these tests parse the emitted
  // response with an independent RFC 3501 reader and assert the ORIGINAL
  // values come back out — asserting the escaped bytes directly would just
  // restate the implementation.
  describe("quoted-string encoding", () => {
    type Token = string | null | Token[];

    /**
     * Minimal RFC 3501 §9 response reader: parenthesized lists, quoted
     * strings (with `\` escapes), NIL, and bare atoms. Throws on anything
     * the grammar forbids — an unterminated string, or a raw CR/LF inside a
     * quoted string — which is exactly the client-side failure both encoding
     * rules exist to prevent.
     */
    const parse = (input: string): Token[] => {
      let i = 0;

      const readQuoted = (): string => {
        i++; // opening DQUOTE
        let out = "";
        for (;;) {
          if (i >= input.length) throw new Error("unterminated quoted string");
          const ch = input[i];
          if (ch === "\\") {
            const next = input[i + 1];
            if (next !== '"' && next !== "\\") {
              throw new Error(`illegal escape \\${next}`);
            }
            out += next;
            i += 2;
            continue;
          }
          if (ch === '"') {
            i++;
            return out;
          }
          if (ch === "\r" || ch === "\n" || ch === "\0") {
            throw new Error("CR/LF/NUL inside quoted string");
          }
          out += ch;
          i++;
        }
      };

      const readList = (): Token[] => {
        i++; // opening paren
        const items: Token[] = [];
        for (;;) {
          if (i >= input.length) throw new Error("unterminated list");
          if (input[i] === ")") {
            i++;
            return items;
          }
          if (input[i] === " ") {
            i++;
            continue;
          }
          items.push(readToken());
        }
      };

      const readToken = (): Token => {
        const ch = input[i];
        if (ch === "(") return readList();
        if (ch === '"') return readQuoted();
        let atom = "";
        while (i < input.length && input[i] !== " " && input[i] !== ")") {
          atom += input[i];
          i++;
        }
        return atom === "NIL" ? null : atom;
      };

      const tokens: Token[] = [];
      while (i < input.length) {
        if (input[i] === " ") {
          i++;
          continue;
        }
        tokens.push(readToken());
      }
      return tokens;
    };

    const parseEnvelope = (mail: Partial<MailType>): Token[] => {
      const wire = formatEnvelope(mail);
      const parsed = parse(wire);
      expect(parsed).toHaveLength(1);
      const envelope = parsed[0];
      if (!Array.isArray(envelope)) throw new Error("envelope is not a list");
      // date subject from sender reply-to to cc bcc in-reply-to message-id
      expect(envelope).toHaveLength(10);
      return envelope;
    };

    describe("the test's own parser", () => {
      // The reader is the measuring instrument for every case below, so pin
      // that it actually rejects what it claims to reject.
      it("rejects an unterminated string and a raw line break", () => {
        expect(() => parse('("Bob\\" NIL)')).toThrow();
        expect(() => parse('("A\nB")')).toThrow();
      });

      it("round-trips a legally escaped value", () => {
        expect(parse('("a\\\\b" "c\\"d" NIL x)')).toEqual([
          ["a\\b", 'c"d', null, "x"],
        ]);
      });
    });

    describe("backslash escaping", () => {
      it("keeps the response parseable when a subject ends in a backslash", () => {
        const subject = "Re: C:\\Users\\";
        const envelope = parseEnvelope({ subject, messageId: "<id@example>" });
        expect(envelope[1]).toBe(subject);
        // The desync signature: if the trailing `\` escaped the terminator,
        // the message-id slot would have swallowed the tokens after it.
        expect(envelope[9]).toBe("<id@example>");
      });

      it("keeps the response parseable when a display name ends in a backslash", () => {
        const envelope = parseEnvelope({
          subject: "hi",
          from: {
            text: "",
            value: [{ name: "Bob\\", address: "bob@example.com" }],
          },
        } as Partial<MailType>);
        expect(envelope[2]).toEqual([["Bob\\", null, "bob", "example.com"]]);
      });

      it("escapes quotes in a Message-ID — a legal RFC 5322 quoted id-left", () => {
        const messageId = '<"a\\"b"@example.com>';
        const envelope = parseEnvelope({ subject: "hi", messageId });
        expect(envelope[9]).toBe(messageId);
      });

      it("survives an envelope carrying both hazards at once", () => {
        const envelope = parseEnvelope({
          subject: "Re: C:\\Users\\ path",
          messageId: '<"a\\"b"@example.com>',
          from: {
            text: "",
            value: [{ name: "Bob\\", address: "bob@example.com" }],
          },
        } as Partial<MailType>);
        expect(envelope[1]).toBe("Re: C:\\Users\\ path");
        expect(envelope[2]).toEqual([["Bob\\", null, "bob", "example.com"]]);
        expect(envelope[9]).toBe('<"a\\"b"@example.com>');
      });
    });

    describe("CR/LF exclusion", () => {
      it("emits one line for a display name containing a line break", () => {
        const mail = {
          subject: "hi",
          from: {
            text: "",
            value: [{ name: "A\nB", address: "a@example.com" }],
          },
        } as Partial<MailType>;

        const wire = formatEnvelope(mail);
        expect(wire).not.toContain("\n");
        expect(wire).not.toContain("\r");

        const envelope = parseEnvelope(mail);
        expect(envelope[2]).toEqual([["A B", null, "a", "example.com"]]);
      });

      it("collapses CRLF runs in a subject to a single space", () => {
        const envelope = parseEnvelope({ subject: "one\r\n\r\ntwo" });
        expect(envelope[1]).toBe("one two");
      });

      it("strips NUL, which is outside CHAR for the same grammar reason", () => {
        const envelope = parseEnvelope({ subject: "a\0b" });
        expect(envelope[1]).toBe("a b");
      });
    });

    describe("BODYSTRUCTURE attachment params", () => {
      const attachmentBody = (filename: string, contentType?: string) => {
        const wire = formatBodyStructure({
          text: "body",
          attachments: [
            { filename, contentType, size: 12 },
          ] as AttachmentType[],
        } as Partial<MailType>);
        const parsed = parse(wire);
        expect(parsed).toHaveLength(1);
        const multipart = parsed[0];
        if (!Array.isArray(multipart)) throw new Error("not a multipart list");
        const attachment = multipart[1];
        if (!Array.isArray(attachment)) throw new Error("not an attachment");
        return attachment;
      };

      it("round-trips a filename containing a quote and a backslash", () => {
        const filename = 'in"voice\\';
        const attachment = attachmentBody(filename, "application/pdf");
        expect(attachment[0]).toBe("application");
        expect(attachment[1]).toBe("pdf");
        expect(attachment[2]).toEqual(["NAME", filename]);
        // extension data: MD5, disposition, language, location
        expect(attachment[8]).toEqual(["ATTACHMENT", ["FILENAME", filename]]);
      });

      it("emits a real subtype when the stored contentType has no slash", () => {
        const attachment = attachmentBody("a.bin", "application");
        expect(attachment[0]).toBe("application");
        expect(attachment[1]).toBe("octet-stream");
      });

      it("emits a real media type when the stored contentType has no type half", () => {
        // "/pdf" splits to ["", "pdf"] — an empty string, not undefined, so a
        // destructuring default would not fire and `"" "pdf"` would reach the
        // wire as an empty media type.
        const attachment = attachmentBody("a.bin", "/pdf");
        expect(attachment[0]).toBe("application");
        expect(attachment[1]).toBe("pdf");
      });

      it("routes the media type and subtype through the encoder", () => {
        // contentType is stored per-attachment and is not validated, so the
        // type halves are as attacker-influenced as the filename.
        const attachment = attachmentBody("a.bin", 'ap"p/pd\\f');
        expect(attachment[0]).toBe('ap"p');
        expect(attachment[1]).toBe("pd\\f");
      });

      it("emits the same media type in the part header as in BODYSTRUCTURE", () => {
        // A Content-Type with a missing half is unparseable, so a client that
        // trusts the header renders the part inline as text while the
        // BODYSTRUCTURE-driven list shows it as an attachment.
        const shapes = ["application", "/pdf", "application/", undefined];
        const emitted = shapes.map((contentType) => {
          const attachment = attachmentBody("a.bin", contentType);
          const { contentType: header } = attachmentPartHeaderFields({
            contentType,
            filename: "a.bin",
          } as AttachmentType);
          return {
            stored: contentType,
            bodystructure: `${attachment[0]}/${attachment[1]}`,
            header,
          };
        });
        expect(emitted).toEqual([
          {
            stored: "application",
            bodystructure: "application/octet-stream",
            header: "application/octet-stream",
          },
          {
            stored: "/pdf",
            bodystructure: "application/pdf",
            header: "application/pdf",
          },
          {
            stored: "application/",
            bodystructure: "application/octet-stream",
            header: "application/octet-stream",
          },
          {
            stored: undefined,
            bodystructure: "application/octet-stream",
            header: "application/octet-stream",
          },
        ]);
      });
    });

    describe("address local part and domain", () => {
      // Both halves come from the stored address, which mailparser fills from
      // the inbound header — a quoted local part is legal RFC 5322 and reaches
      // the wire as a quoted string like every other stored value.
      it("round-trips a local part containing a quote and a backslash", () => {
        const envelope = parseEnvelope({
          subject: "hi",
          from: {
            text: "",
            value: [{ name: "X", address: 'we"ird\\local@example.com' }],
          },
        } as Partial<MailType>);
        expect(envelope[2]).toEqual([
          ["X", null, 'we"ird\\local', "example.com"],
        ]);
      });

      it("round-trips a domain containing a quoted-special", () => {
        const envelope = parseEnvelope({
          subject: "hi",
          from: {
            text: "",
            value: [{ name: "X", address: 'user@ex"ample.com' }],
          },
        } as Partial<MailType>);
        expect(envelope[2]).toEqual([["X", null, "user", 'ex"ample.com']]);
      });
    });

    describe("quoteString / formatNString", () => {
      it("leaves an ordinary value untouched — no double escaping", () => {
        expect(quoteString("Hello there")).toBe('"Hello there"');
        expect(formatNString("Hello")).toBe('"Hello"');
      });

      it("escapes both quoted-specials", () => {
        expect(quoteString('a"b')).toBe('"a\\"b"');
        expect(quoteString("a\\b")).toBe('"a\\\\b"');
        expect(quoteString("\\")).toBe('"\\\\"');
      });

      it("returns the bare atom NIL for an absent value", () => {
        expect(formatNString(undefined)).toBe("NIL");
        expect(formatNString(null)).toBe("NIL");
        expect(formatNString("")).toBe("NIL");
      });
    });
  });
});
