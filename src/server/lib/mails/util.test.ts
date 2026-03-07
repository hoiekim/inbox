import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  TO_ADDRESS_FIELD,
  FROM_ADDRESS_FIELD,
  nestedPath,
  getDomain,
  getUserDomain,
  ATTACHMENT_FOLDER,
  getAttachmentFilePath,
  getText,
} from "./util";

describe("field constants", () => {
  it("should have correct TO_ADDRESS_FIELD", () => {
    expect(TO_ADDRESS_FIELD).toBe("mail.envelopeTo.address");
  });

  it("should have correct FROM_ADDRESS_FIELD", () => {
    expect(FROM_ADDRESS_FIELD).toBe("mail.from.value.address");
  });

  it("should have correct ATTACHMENT_FOLDER", () => {
    expect(ATTACHMENT_FOLDER).toBe("./attachments");
  });
});

describe("nestedPath", () => {
  it("should return path without last segment", () => {
    expect(nestedPath("mail.envelopeTo.address")).toBe("mail.envelopeTo");
    expect(nestedPath("mail.from.value.address")).toBe("mail.from.value");
  });

  it("should handle single segment (returns all but last char when no dot)", () => {
    // Note: implementation uses lastIndexOf(".") which returns -1 when no dot found
    // slice(0, -1) then returns all but the last character
    expect(nestedPath("field")).toBe("fiel");
  });

  it("should handle two segments", () => {
    expect(nestedPath("parent.child")).toBe("parent");
  });
});

describe("getDomain", () => {
  const originalEnv = process.env.EMAIL_DOMAIN;

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.EMAIL_DOMAIN = originalEnv;
    } else {
      delete process.env.EMAIL_DOMAIN;
    }
  });

  it("should return EMAIL_DOMAIN when set", () => {
    process.env.EMAIL_DOMAIN = "custom.domain.com";
    expect(getDomain()).toBe("custom.domain.com");
  });

  it("should return 'mydomain' as default", () => {
    delete process.env.EMAIL_DOMAIN;
    expect(getDomain()).toBe("mydomain");
  });
});

describe("getUserDomain", () => {
  const originalEnv = process.env.EMAIL_DOMAIN;

  beforeAll(() => {
    process.env.EMAIL_DOMAIN = "example.com";
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.EMAIL_DOMAIN = originalEnv;
    } else {
      delete process.env.EMAIL_DOMAIN;
    }
  });

  it("should return base domain for admin user", () => {
    expect(getUserDomain("admin")).toBe("example.com");
  });

  it("should return subdomain for regular users", () => {
    expect(getUserDomain("john")).toBe("john.example.com");
    expect(getUserDomain("support")).toBe("support.example.com");
  });
});

describe("getAttachmentFilePath", () => {
  it("should return path with given id", () => {
    const path = getAttachmentFilePath("abc-123");
    expect(path).toBe("./attachments/abc-123");
  });
});

describe("getText", () => {
  it("should convert simple HTML to text", () => {
    const html = "<p>Hello, world!</p>";
    const text = getText(html);
    expect(text).toBe("Hello, world!");
  });

  it("should handle multiple paragraphs", () => {
    const html = "<p>First paragraph.</p><p>Second paragraph.</p>";
    const text = getText(html);
    expect(text).toContain("First paragraph.");
    expect(text).toContain("Second paragraph.");
  });

  it("should skip images", () => {
    const html = '<p>Text before<img src="image.jpg" alt="test">Text after</p>';
    const text = getText(html);
    expect(text).not.toContain("image.jpg");
    expect(text).not.toContain("[test]");
    expect(text).toContain("Text before");
    expect(text).toContain("Text after");
  });

  it("should handle links without displaying href", () => {
    const html = '<p>Visit <a href="https://example.com">our site</a></p>';
    const text = getText(html);
    expect(text).toContain("our site");
    expect(text).not.toContain("example.com");
  });

  it("should replace URLs with [url] placeholder", () => {
    const html = "<p>Check out https://example.com/page for more info</p>";
    const text = getText(html);
    expect(text).toContain("[url]");
    expect(text).not.toContain("https://example.com");
  });

  it("should compress multiple spaces", () => {
    const html = "<p>Too    many     spaces</p>";
    const text = getText(html);
    expect(text).toBe("Too many spaces");
  });

  it("should compress multiple newlines", () => {
    const html = "<p>Line 1</p><br><br><br><p>Line 2</p>";
    const text = getText(html);
    // Should not have excessive newlines
    expect(text.match(/\n{3,}/g)).toBeNull();
  });

  it("should handle complex HTML email", () => {
    const html = `
      <html>
        <body>
          <h1>Newsletter</h1>
          <p>Dear subscriber,</p>
          <p>Check out our <a href="https://example.com/products">new products</a>!</p>
          <img src="banner.jpg" alt="Banner">
          <p>Best regards,<br>The Team</p>
        </body>
      </html>
    `;
    const text = getText(html);
    expect(text).toContain("NEWSLETTER"); // h1 gets uppercased by html-to-text
    expect(text).toContain("Dear subscriber");
    expect(text).toContain("new products");
    expect(text).toContain("Best regards");
    expect(text).not.toContain("banner.jpg");
    expect(text).not.toContain("https://");
  });
});
