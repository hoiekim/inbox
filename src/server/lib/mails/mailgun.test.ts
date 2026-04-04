import { describe, it, expect, mock, beforeEach } from "bun:test";

// Set EMAIL_DOMAIN before module is loaded (it destructures process.env at init time)
process.env.EMAIL_DOMAIN = "mydomain";
process.env.MAILGUN_KEY = "test-key";

// Mock fs first (before mailgun.ts is imported)
const mockReadFileSync = mock(() => Buffer.from("file-content"));
mock.module("fs", () => ({
  default: { readFileSync: mockReadFileSync },
  readFileSync: mockReadFileSync,
}));

// Mock form-data
mock.module("form-data", () => ({
  default: class FormData {},
}));

// Track mailgun API calls
const mockMessagesCreate = mock(() =>
  Promise.resolve({ id: "msg-id-123", message: "Queued. Thank you." })
);

// Mock mailgun.js — the module exports a default class whose instances have .client()
mock.module("mailgun.js", () => {
  class MockMailgun {
    client(_opts: any) {
      return { messages: { create: mockMessagesCreate } };
    }
  }
  return { default: MockMailgun };
});

// Mock logger
mock.module("../logger", () => ({
  logger: {
    info: mock(() => {}),
    error: mock(() => {}),
    warn: mock(() => {}),
    debug: mock(() => {}),
  },
}));

// Mock server exports
mock.module("server", () => ({
  getText: (html: string) => html.replace(/<[^>]*>/g, ""),
  getUserDomain: (username: string) =>
    username === "admin" ? "example.com" : `${username}.example.com`,
  getDomain: () => "example.com",
}));

import { sendMailgunMail } from "./mailgun";

const baseMail = {
  sender: "admin",
  senderFullName: "",
  to: "recipient@external.com",
  cc: undefined,
  bcc: undefined,
  subject: "Test Subject",
  html: "<p>Hello</p>",
  inReplyTo: undefined,
};

describe("sendMailgunMail", () => {
  beforeEach(() => {
    mockMessagesCreate.mockReset();
    mockMessagesCreate.mockResolvedValue({ id: "msg-id-123", message: "Queued. Thank you." });
    mockReadFileSync.mockReset();
    mockReadFileSync.mockReturnValue(Buffer.from("file-content"));
    process.env.EMAIL_DOMAIN = "mydomain";
    process.env.MAILGUN_KEY = "test-key";
  });

  it("should send when recipients include external addresses", async () => {
    const mail = { ...baseMail, to: "external@gmail.com" };
    await sendMailgunMail("admin", mail as any);
    expect(mockMessagesCreate).toHaveBeenCalled();
  });

  it("should pass the envelope to as an array of trimmed addresses", async () => {
    const mail = { ...baseMail, to: "a@gmail.com, b@yahoo.com" };
    await sendMailgunMail("admin", mail as any);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    const toList: string[] = Array.isArray(msgData.to) ? msgData.to : [msgData.to];
    expect(toList).toContain("a@gmail.com");
    expect(toList).toContain("b@yahoo.com");
  });

  it("should always include the original h:To header", async () => {
    const toValue = "a@gmail.com, b@yahoo.com";
    const mail = { ...baseMail, to: toValue };
    await sendMailgunMail("admin", mail as any);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData["h:To"]).toBe(toValue);
  });

  it("should include the original To header for all recipients", async () => {
    const toValue = "external@gmail.com, internal@mydomain";
    const mail = { ...baseMail, to: toValue };
    await sendMailgunMail("admin", mail as any);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData["h:To"]).toBe(toValue);
  });

  it("should format from address with senderFullName when provided", async () => {
    // EMAIL_DOMAIN is frozen at module load time ("mydomain")
    // getUserDomain mock returns "example.com" for admin
    const mail = { ...baseMail, senderFullName: "Admin User" };
    await sendMailgunMail("admin", mail as any);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.from).toContain("Admin User");
    expect(msgData.from).toContain("admin@");
  });

  it("should format from address without senderFullName when not provided", async () => {
    const mail = { ...baseMail, senderFullName: "" };
    await sendMailgunMail("admin", mail as any);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.from).toContain("admin@");
    expect(msgData.from).not.toContain(" <"); // no name part
  });

  it("should include subject, html, and text in message", async () => {
    const mail = { ...baseMail, subject: "My Test Subject", html: "<p>Hello World</p>" };
    await sendMailgunMail("admin", mail as any);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.subject).toBe("My Test Subject");
    expect(msgData.html).toBe("<p>Hello World</p>");
    expect(msgData.text).toBeDefined();
  });

  it("should include cc and bcc when provided", async () => {
    const mail = { ...baseMail, cc: "cc@external.com", bcc: "bcc@external.com" };
    await sendMailgunMail("admin", mail as any);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.cc).toBe("cc@external.com");
    expect(msgData.bcc).toBe("bcc@external.com");
  });

  it("should include inReplyTo header when provided", async () => {
    const mail = { ...baseMail, inReplyTo: "<original-msg@example.com>" };
    await sendMailgunMail("admin", mail as any);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData["h:In-Reply-To"]).toBe("<original-msg@example.com>");
  });

  it("should return data from mailgun API on success", async () => {
    const expected = { id: "msg-id-999", message: "Queued. Thank you." };
    mockMessagesCreate.mockResolvedValue(expected);
    const result = await sendMailgunMail("admin", baseMail as any);
    expect(result).toEqual(expected);
  });

  it("should handle file attachment from tempFilePath", async () => {
    const mockFile = {
      name: "test.pdf",
      mimetype: "application/pdf",
      size: 1024,
      tempFilePath: "/tmp/uploaded-file.pdf",
      data: Buffer.alloc(0),
    };
    await sendMailgunMail("admin", baseMail as any, mockFile as any);
    expect(mockReadFileSync).toHaveBeenCalledWith("/tmp/uploaded-file.pdf");
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.attachment).toHaveLength(1);
    expect(msgData.attachment[0].filename).toBe("test.pdf");
  });

  it("should handle file attachment from data buffer", async () => {
    const fileData = Buffer.from("file-content");
    const mockFile = {
      name: "image.jpg",
      mimetype: "image/jpeg",
      size: 512,
      tempFilePath: "",
      data: fileData,
    };
    await sendMailgunMail("admin", baseMail as any, mockFile as any);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.attachment).toHaveLength(1);
    expect(msgData.attachment[0].filename).toBe("image.jpg");
  });

  it("should handle array of file attachments", async () => {
    const mockFiles = [
      { name: "a.pdf", mimetype: "application/pdf", size: 100, tempFilePath: "", data: Buffer.from("a") },
      { name: "b.pdf", mimetype: "application/pdf", size: 200, tempFilePath: "", data: Buffer.from("b") },
    ];
    await sendMailgunMail("admin", baseMail as any, mockFiles as any);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.attachment).toHaveLength(2);
  });

  it("should propagate errors from mailgun API", async () => {
    mockMessagesCreate.mockRejectedValue(new Error("Mailgun API error"));
    const mail = { ...baseMail };
    await expect(sendMailgunMail("admin", mail as any)).rejects.toThrow("Mailgun API error");
  });
});
